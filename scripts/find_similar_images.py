#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线相似图检测（只读图鉴与原图，指纹缓存写入 SQLite）。

把每张图规范成正方形后再比感知哈希和灰度向量，因此原图比例不同
（拉伸、裁切、加黑边）仍能判为同一张图。适合图鉴去重的第一阶段：
只列出相似组，不合并、不删除。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import sqlite3

import numpy as np
from PIL import Image, ImageOps

import yelulu_db

ALGO_VERSION = 1
ALGO_NAME = "stretch-cover-phash-embed"
EMBED_SIZE = 16
HASH_HIGHFREQ = 4
FINGERPRINT_SIZE = 256
DEFAULT_THRESHOLD = 0.90
DEFAULT_HASH_SIZE = 16
WORKERS = 4
CACHE_VERSION = 1

# 只读保证：不得改图鉴表与原图；仅写入去重缓存表


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def emit_progress(phase, done=0, total=0, message=""):
    payload = {
        "phase": phase,
        "done": int(done),
        "total": int(total),
        "message": message,
    }
    eprint("PROGRESS\t" + json.dumps(payload, ensure_ascii=False), flush=True)


def dct_matrix(n):
    k = np.arange(n, dtype=np.float64)[:, None]
    i = np.arange(n, dtype=np.float64)[None, :]
    mat = np.cos(np.pi * (2.0 * i + 1.0) * k / (2.0 * n))
    mat[0] *= np.sqrt(1.0 / n)
    mat[1:] *= np.sqrt(2.0 / n)
    return mat


_DCT_CACHE = {}


def dct_2d(arr):
    n, m = arr.shape
    if n not in _DCT_CACHE:
        _DCT_CACHE[n] = dct_matrix(n)
    if m not in _DCT_CACHE:
        _DCT_CACHE[m] = dct_matrix(m)
    return _DCT_CACHE[n] @ arr @ _DCT_CACHE[m].T


def bits_to_hex(bits):
    packed = np.packbits(np.asarray(bits, dtype=np.uint8).ravel())
    return packed.tobytes().hex()


def hex_to_bits(hex_str, bit_count):
    packed = np.frombuffer(bytes.fromhex(hex_str), dtype=np.uint8)
    bits = np.unpackbits(packed)
    if bits.size < bit_count:
        bits = np.pad(bits, (0, bit_count - bits.size))
    return bits[:bit_count].astype(np.float32)


def pack_embed(vec):
    q = np.clip(np.round(np.asarray(vec, dtype=np.float32) * 32767.0), -32767, 32767)
    return base64.b64encode(q.astype(np.int16).tobytes()).decode("ascii")


def unpack_embed(blob):
    raw = np.frombuffer(base64.b64decode(blob), dtype=np.int16)
    vec = raw.astype(np.float32) / 32767.0
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec


def sha256_file(path, chunk=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def load_rgb(path):
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        if getattr(img, "n_frames", 1) > 1:
            img.seek(0)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            rgba = img.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            return bg
        return img.convert("RGB")


def _is_uniform_line(line, std_thresh=7.0):
    return float(line.std()) < std_thresh


def trim_letterbox(rgb):
    """只裁成对的近纯色边（常见黑/白边），避免把天空一类单边背景裁掉。"""
    gray = rgb.mean(axis=2)
    height, width = gray.shape
    if height < 16 or width < 16:
        return rgb

    max_v = max(1, int(height * 0.22))
    max_h = max(1, int(width * 0.22))
    top = 0
    while top < max_v:
        a = gray[top]
        b = gray[height - 1 - top]
        if not (_is_uniform_line(a) and _is_uniform_line(b)):
            break
        if abs(float(a.mean()) - float(b.mean())) > 14:
            break
        top += 1

    left = 0
    while left < max_h:
        a = gray[:, left]
        b = gray[:, width - 1 - left]
        if not (_is_uniform_line(a) and _is_uniform_line(b)):
            break
        if abs(float(a.mean()) - float(b.mean())) > 14:
            break
        left += 1

    if top < 3 and left < 3:
        return rgb

    trimmed = rgb[top:height - top, left:width - left]
    if trimmed.shape[0] < 8 or trimmed.shape[1] < 8:
        return rgb
    return trimmed


def stretch_square(im, size):
    return im.resize((size, size), Image.Resampling.LANCZOS)


def cover_square(im, size):
    width, height = im.size
    if width <= 0 or height <= 0:
        return stretch_square(im, size)
    scale = max(size / width, size / height)
    new_w = max(size, int(round(width * scale)))
    new_h = max(size, int(round(height * scale)))
    resized = im.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = (new_w - size) // 2
    top = (new_h - size) // 2
    return resized.crop((left, top, left + size, top + size))


def perceptual_hash(gray_u8, hash_size):
    side = hash_size * HASH_HIGHFREQ
    if gray_u8.shape != (side, side):
        im = Image.fromarray(gray_u8).resize((side, side), Image.Resampling.LANCZOS)
        pixels = np.asarray(im, dtype=np.float64)
    else:
        pixels = gray_u8.astype(np.float64)
    low = dct_2d(pixels)[:hash_size, :hash_size]
    bits = low > np.median(low)
    return bits_to_hex(bits)


def embed_vector(gray_u8):
    if gray_u8.shape != (EMBED_SIZE, EMBED_SIZE):
        im = Image.fromarray(gray_u8).resize(
            (EMBED_SIZE, EMBED_SIZE), Image.Resampling.LANCZOS
        )
        pixels = np.asarray(im, dtype=np.float32)
    else:
        pixels = gray_u8.astype(np.float32)
    vec = pixels.ravel()
    vec -= float(vec.mean())
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec


def variant_features(rgb_im, hash_size):
    gray = np.asarray(rgb_im.convert("L"), dtype=np.uint8)
    phash_side = hash_size * HASH_HIGHFREQ
    phash_gray = np.asarray(
        Image.fromarray(gray).resize((phash_side, phash_side), Image.Resampling.LANCZOS),
        dtype=np.uint8,
    )
    embed_gray = np.asarray(
        Image.fromarray(gray).resize((EMBED_SIZE, EMBED_SIZE), Image.Resampling.LANCZOS),
        dtype=np.uint8,
    )
    return {
        "phash": perceptual_hash(phash_gray, hash_size),
        "embed": pack_embed(embed_vector(embed_gray)),
    }


def fingerprint_image(path, hash_size):
    rgb = load_rgb(path)
    width, height = rgb.size
    arr = np.asarray(rgb, dtype=np.uint8)
    trimmed = trim_letterbox(arr)
    work = Image.fromarray(trimmed)
    stretch = stretch_square(work, FINGERPRINT_SIZE)
    cover = cover_square(work, FINGERPRINT_SIZE)
    return {
        "width": width,
        "height": height,
        "fileSha256": sha256_file(path),
        "stretch": variant_features(stretch, hash_size),
        "cover": variant_features(cover, hash_size),
    }


class UnionFind:
    def __init__(self, n):
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x):
        parent = self.parent
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            self.parent[ra] = rb
        elif self.rank[ra] > self.rank[rb]:
            self.parent[rb] = ra
        else:
            self.parent[rb] = ra
            self.rank[ra] += 1


def default_paths():
    return {
        "db": yelulu_db.SQLITE_PATH,
        "images": yelulu_db.IMAGES_DIR,
    }


def empty_cache():
    return {"version": CACHE_VERSION, "algorithm": ALGO_NAME, "files": {}}


def load_cache(conn):
    try:
        meta = conn.execute(
            "SELECT version, algorithm FROM dedup_cache_meta WHERE id = 1"
        ).fetchone()
        if not meta:
            return empty_cache()
        if meta["version"] != CACHE_VERSION or meta["algorithm"] != ALGO_NAME:
            return empty_cache()
        files = {}
        for row in conn.execute("SELECT filename, payload FROM dedup_cache"):
            try:
                entry = json.loads(row["payload"])
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if row["filename"] and isinstance(entry, dict):
                files[row["filename"]] = entry
        return {"version": CACHE_VERSION, "algorithm": ALGO_NAME, "files": files}
    except sqlite3.Error:
        return empty_cache()


def save_cache(conn, cache):
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM dedup_cache")
        conn.execute(
            "INSERT OR REPLACE INTO dedup_cache_meta (id, version, algorithm) VALUES (1, ?, ?)",
            (cache.get("version") or CACHE_VERSION, cache.get("algorithm") or ALGO_NAME),
        )
        rows = [
            (filename, json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
            for filename, entry in (cache.get("files") or {}).items()
            if filename and isinstance(entry, dict)
        ]
        conn.executemany(
            "INSERT INTO dedup_cache (filename, payload) VALUES (?, ?)",
            rows,
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    yelulu_db.checkpoint(conn)


def cache_key_stat(path):
    stat = os.stat(path)
    return int(stat.st_mtime * 1000), int(stat.st_size)


def cache_hit(entry, mtime_ms, size, hash_size):
    if not isinstance(entry, dict):
        return False
    if entry.get("mtimeMs") != mtime_ms or entry.get("size") != size:
        return False
    if entry.get("hashSize") != hash_size:
        return False
    if entry.get("algoVersion") != ALGO_VERSION:
        return False
    stretch = entry.get("stretch") or {}
    cover = entry.get("cover") or {}
    return all(
        (
            entry.get("fileSha256"),
            stretch.get("phash"),
            stretch.get("embed"),
            cover.get("phash"),
            cover.get("embed"),
        )
    )


def select_birds(birds, include_pending, include_rejected, limit):
    statuses = {"approved"}
    if include_pending:
        statuses.add("pending")
    if include_rejected:
        statuses.add("rejected")

    selected = []
    for bird in birds:
        if not isinstance(bird, dict):
            continue
        status = bird.get("status") or "approved"
        if status not in statuses:
            continue
        image_url = bird.get("imageUrl")
        if not image_url:
            continue
        selected.append(bird)
        if limit and len(selected) >= limit:
            break
    return selected


def build_fingerprints(items, images_dir, hash_size, cache, use_cache, workers):
    results = [None] * len(items)
    skipped = []
    to_compute = []

    for index, bird in enumerate(items):
        filename = os.path.basename(str(bird.get("imageUrl") or ""))
        path = os.path.join(images_dir, filename)
        if not filename or not os.path.isfile(path):
            skipped.append({
                "id": bird.get("id"),
                "name": bird.get("name"),
                "imageUrl": bird.get("imageUrl"),
                "reason": "missing_file",
            })
            continue
        mtime_ms, size = cache_key_stat(path)
        entry = cache["files"].get(filename)
        if use_cache and cache_hit(entry, mtime_ms, size, hash_size):
            results[index] = {
                "bird": bird,
                "filename": filename,
                "path": path,
                "width": entry.get("width"),
                "height": entry.get("height"),
                "fileSha256": entry["fileSha256"],
                "stretch": entry["stretch"],
                "cover": entry["cover"],
            }
            continue
        to_compute.append((index, bird, filename, path, mtime_ms, size))

    total = len(to_compute)
    done = 0
    emit_progress(
        "fingerprint",
        0,
        max(total, 1),
        "使用缓存" if total == 0 else "计算感知指纹",
    )

    def compute_one(job):
        index, bird, filename, path, mtime_ms, size = job
        try:
            feat = fingerprint_image(path, hash_size)
        except Exception as error:
            return {
                "ok": False,
                "index": index,
                "bird": bird,
                "error": str(error),
            }
        feat.update({
            "mtimeMs": mtime_ms,
            "size": size,
            "hashSize": hash_size,
            "algoVersion": ALGO_VERSION,
        })
        return {
            "ok": True,
            "index": index,
            "bird": bird,
            "filename": filename,
            "path": path,
            "feat": feat,
        }

    if to_compute:
        pool = ThreadPoolExecutor(max_workers=max(1, workers))
        try:
            futures = [pool.submit(compute_one, job) for job in to_compute]
            for future in as_completed(futures):
                item = future.result()
                done += 1
                emit_progress("fingerprint", done, total, "计算感知指纹")
                if not item["ok"]:
                    bird = item["bird"]
                    skipped.append({
                        "id": bird.get("id"),
                        "name": bird.get("name"),
                        "imageUrl": bird.get("imageUrl"),
                        "reason": "decode_error",
                        "detail": item["error"],
                    })
                    continue
                index = item["index"]
                filename = item["filename"]
                path = item["path"]
                feat = item["feat"]
                bird = item["bird"]
                cache["files"][filename] = {
                    "mtimeMs": feat["mtimeMs"],
                    "size": feat["size"],
                    "hashSize": feat["hashSize"],
                    "algoVersion": feat["algoVersion"],
                    "width": feat["width"],
                    "height": feat["height"],
                    "fileSha256": feat["fileSha256"],
                    "stretch": feat["stretch"],
                    "cover": feat["cover"],
                }
                results[index] = {
                    "bird": bird,
                    "filename": filename,
                    "path": path,
                    "width": feat["width"],
                    "height": feat["height"],
                    "fileSha256": feat["fileSha256"],
                    "stretch": feat["stretch"],
                    "cover": feat["cover"],
                }
        finally:
            pool.shutdown(wait=True)

    records = [item for item in results if item is not None]
    return records, skipped


def similarity_matrices(records, hash_size):
    bits = hash_size * hash_size
    stretch_bits = np.stack([hex_to_bits(r["stretch"]["phash"], bits) for r in records])
    cover_bits = np.stack([hex_to_bits(r["cover"]["phash"], bits) for r in records])
    stretch_emb = np.stack([unpack_embed(r["stretch"]["embed"]) for r in records])
    cover_emb = np.stack([unpack_embed(r["cover"]["embed"]) for r in records])

    def phash_sim(bit_arr):
        dots = bit_arr @ bit_arr.T
        card = bit_arr.sum(axis=1)
        hamming = card[:, None] + card[None, :] - 2.0 * dots
        return 1.0 - hamming / float(bits)

    ph_s = phash_sim(stretch_bits)
    ph_c = phash_sim(cover_bits)
    em_s = stretch_emb @ stretch_emb.T
    em_c = cover_emb @ cover_emb.T
    em_x = stretch_emb @ cover_emb.T
    em_x = np.maximum(em_x, em_x.T)

    phash_best = np.maximum(ph_s, ph_c)
    embed_best = np.maximum(np.maximum(em_s, em_c), em_x)
    combined = 0.62 * phash_best + 0.38 * embed_best
    score = np.maximum(phash_best, combined)
    return phash_best, embed_best, score


def cluster_records(records, threshold, phash_best, embed_best, score):
    count = len(records)
    match = np.zeros((count, count), dtype=bool)
    margin = 0.08
    match |= phash_best >= threshold
    match |= (phash_best >= (threshold - margin)) & (embed_best >= threshold)
    np.fill_diagonal(match, False)

    sha_groups = defaultdict(list)
    for index, record in enumerate(records):
        sha_groups[record["fileSha256"]].append(index)

    exact_pairs = set()
    for indexes in sha_groups.values():
        if len(indexes) < 2:
            continue
        for i, left in enumerate(indexes):
            for right in indexes[i + 1:]:
                match[left, right] = True
                match[right, left] = True
                score[left, right] = 1.0
                score[right, left] = 1.0
                exact_pairs.add((min(left, right), max(left, right)))

    uf = UnionFind(count)
    edges = {}
    for i in range(count):
        js = np.flatnonzero(match[i, i + 1:])
        for offset in js:
            j = i + 1 + int(offset)
            uf.union(i, j)
            pair_score = float(score[i, j])
            if phash_best[i, j] >= threshold:
                method = "phash"
            elif (i, j) in exact_pairs:
                method = "exact"
            else:
                method = "embed"
            if (i, j) in exact_pairs:
                method = "exact"
                pair_score = 1.0
            edges[(i, j)] = {"similarity": pair_score, "method": method}

    buckets = defaultdict(list)
    for index in range(count):
        buckets[uf.find(index)].append(index)

    groups = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        member_set = set(members)
        group_edges = [
            (i, j, meta)
            for (i, j), meta in edges.items()
            if i in member_set and j in member_set
        ]
        if not group_edges:
            continue
        sims = [meta["similarity"] for _, _, meta in group_edges]
        methods = {meta["method"] for _, _, meta in group_edges}
        if "exact" in methods:
            reason = "exact"
        elif "phash" in methods:
            reason = "phash"
        else:
            reason = "embed"

        group_members = []
        for index in members:
            bird = records[index]["bird"]
            others = [s for i, j, meta in group_edges if index in (i, j) for s in [meta["similarity"]]]
            group_members.append({
                "id": bird.get("id"),
                "name": bird.get("name"),
                "imageUrl": bird.get("imageUrl"),
                "status": bird.get("status") or "approved",
                "createdAt": bird.get("createdAt"),
                "hidden": bird.get("hidden") is True,
                "width": records[index]["width"],
                "height": records[index]["height"],
                "maxSimilarity": round(max(others), 4) if others else 1.0,
            })
        group_members.sort(key=lambda item: (-item["maxSimilarity"], item["id"] or 0))
        groups.append({
            "size": len(group_members),
            "score": round(min(sims), 4),
            "reason": reason,
            "members": group_members,
            "pairs": [
                {
                    "a": records[i]["bird"].get("id"),
                    "b": records[j]["bird"].get("id"),
                    "similarity": round(meta["similarity"], 4),
                    "method": meta["method"],
                }
                for i, j, meta in sorted(group_edges, key=lambda item: -item[2]["similarity"])
            ],
        })

    groups.sort(key=lambda item: (-item["size"], -item["score"], item["members"][0]["id"] or 0))
    for index, group in enumerate(groups, start=1):
        group["id"] = index
    return groups


def assert_read_only(images_dir):
    images_resolved = os.path.abspath(images_dir)
    if not os.path.isdir(images_resolved):
        raise FileNotFoundError("图片目录不存在: " + images_resolved)


def run_scan(args):
    assert_read_only(args.images)
    emit_progress("load", 0, 1, "读取图鉴条目")
    conn = yelulu_db.connect(args.db, readonly=not args.use_cache)
    try:
        birds = yelulu_db.load_birds(conn)
        selected = select_birds(birds, args.include_pending, args.include_rejected, args.limit)
        emit_progress("load", 1, 1, "读取图鉴条目")

        cache = load_cache(conn) if args.use_cache else empty_cache()
        records, skipped = build_fingerprints(
            selected,
            args.images,
            args.hash_size,
            cache,
            args.use_cache,
            args.workers,
        )
        if args.use_cache:
            save_cache(conn, cache)
    finally:
        conn.close()

    emit_progress("compare", 0, 1, "比对相似度")
    groups = []
    if len(records) >= 2:
        phash_best, embed_best, score = similarity_matrices(records, args.hash_size)
        emit_progress("cluster", 0, 1, "聚类分组")
        groups = cluster_records(records, args.threshold, phash_best, embed_best, score)
        emit_progress("cluster", 1, 1, "聚类分组")
    emit_progress("compare", 1, 1, "比对相似度")

    result = {
        "version": 1,
        "readOnly": True,
        "algorithm": ALGO_NAME,
        "algoVersion": ALGO_VERSION,
        "threshold": args.threshold,
        "hashSize": args.hash_size,
        "includePending": args.include_pending,
        "includeRejected": args.include_rejected,
        "scanned": len(records),
        "candidateCount": len(selected),
        "skipped": skipped,
        "groupCount": len(groups),
        "memberCount": sum(group["size"] for group in groups),
        "groups": groups,
    }
    return result


def print_summary(result):
    eprint(
        "扫描 {scanned} 张（候选 {cand}），跳过 {skipped} 张".format(
            scanned=result["scanned"],
            cand=result["candidateCount"],
            skipped=len(result["skipped"]),
        )
    )
    eprint(
        "发现 {groups} 组相似图像，共 {members} 张（只列出，未改任何数据）".format(
            groups=result["groupCount"],
            members=result["memberCount"],
        )
    )
    for group in result["groups"][:20]:
        names = "、".join(
            "{0}#{1}".format(member.get("name") or "?", member.get("id"))
            for member in group["members"][:6]
        )
        extra = "" if group["size"] <= 6 else " 等{0}张".format(group["size"])
        eprint(
            "组 {id}（{size} 张, {score:.1%} {reason}）: {names}{extra}".format(
                id=group["id"],
                size=group["size"],
                score=group["score"],
                reason=group["reason"],
                names=names,
                extra=extra,
            )
        )


def parse_args(argv=None):
    paths = default_paths()
    parser = argparse.ArgumentParser(
        description="离线检测图鉴中的相似图片（只读图鉴与原图，缓存写入 SQLite）"
    )
    parser.add_argument("--db", default=str(paths["db"]), help="SQLite 数据库路径")
    parser.add_argument("--images", default=str(paths["images"]), help="原图目录")
    parser.add_argument("--data", help=argparse.SUPPRESS)
    parser.add_argument("--cache", help=argparse.SUPPRESS)
    parser.add_argument("--output", default="", help="结果 JSON 路径，缺省打印到 stdout")
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_THRESHOLD,
        help="相似度阈值 0.70–0.99，越高越严（默认 0.90）",
    )
    parser.add_argument(
        "--hash-size",
        type=int,
        choices=(8, 16),
        default=DEFAULT_HASH_SIZE,
        help="感知哈希边长：8=64 位，16=256 位",
    )
    parser.add_argument(
        "--include-pending",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="是否包含待审核（默认包含）",
    )
    parser.add_argument(
        "--include-rejected",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="是否包含已拒绝（默认不包含）",
    )
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 条，调试用")
    parser.add_argument("--workers", type=int, default=WORKERS)
    parser.add_argument(
        "--no-cache",
        dest="use_cache",
        action="store_false",
        help="不读写指纹缓存",
    )
    parser.set_defaults(use_cache=True)
    args = parser.parse_args(argv)
    if getattr(args, "data", None) or getattr(args, "cache", None):
        parser.error("已迁移到 SQLite：请使用 --db，指纹缓存也保存在同一数据库中")
    if args.threshold < 0.70 or args.threshold > 0.99:
        parser.error("threshold 需在 0.70 到 0.99 之间")
    if args.workers < 1:
        parser.error("workers 至少为 1")
    return args


def main(argv=None):
    args = parse_args(argv)
    started = time.time()
    result = run_scan(args)
    result["elapsedMs"] = int((time.time() - started) * 1000)
    emit_progress("done", 1, 1, "完成")
    print_summary(result)

    payload = json.dumps(result, ensure_ascii=False)
    if args.output:
        folder = os.path.dirname(os.path.abspath(args.output))
        if folder:
            os.makedirs(folder, exist_ok=True)
        tmp = args.output + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(tmp, args.output)
    else:
        sys.stdout.write(payload)
        sys.stdout.write("\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        eprint("已中断")
        sys.exit(130)
    except Exception as error:
        eprint("ERROR\t" + json.dumps({"message": str(error)}, ensure_ascii=False))
        raise
