/**
 * 图鉴图片去重：感知哈希（phash）+ 灰度向量（embed）
 *
 * 算法与 scripts/find_similar_images.py 完全一致（同一套参数、同一套命中规则）：
 *   1. 灰度化后先裁掉"成对的近纯色边"（常见黑边/白边），再生成两种归一化版本：
 *      stretch = 强行拉成正方形（容忍比例被拉伸），cover = 居中裁成正方形（容忍裁切）；
 *   2. 每种归一化各算两个指纹：
 *      phash = 缩到 64x64 → DCT → 取左上 16x16 低频 → 与中位数比较得到 256 位；
 *      embed = 16x16 灰度向量，去均值后单位化（余弦相似度即为点积）；
 *   3. 相似度 = max(phash 相似度, 0.62*phash + 0.38*embed)；256 位里不同的位越少越像。
 *
 * 命中规则：
 *   phash 相似度 >= 阈值，或 phash >= 阈值-0.08 且 embed >= 阈值；
 *   文件 sha256 完全一致直接算命中（相似度按 1.0 计）。
 *
 * 指纹按"文件名"缓存在 dedup_cache.json（磁盘 mtime+size 变了才重算）。
 * server.js 在增/删/改图后调用 remember/ingestFile/forget 增量维护，
 * 所以正常运行期间每次查重只需给"待上传的那张图"算一次指纹。
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const ALGO_NAME = 'stretch-cover-phash-embed';
const ALGO_VERSION = 1;
const CACHE_VERSION = 1;

const HASH_SIZE = 16;              // 感知哈希边长（位）→ 16x16 = 256 位
const HASH_SIDE = HASH_SIZE * 4;   // 64：先缩到 64x64 再做 DCT
const EMBED_SIZE = 16;             // 灰度向量边长 → 256 维
const DEFAULT_THRESHOLD = 0.90;
const PHASH_MARGIN = 0.08;         // phash 差一点、但 embed 很准时也算命中

const PREVIEW_SIDE = 256;          // 只在这张预览图上做裁边与哈希，避免读整张原图
const UNIFORM_STD = 7.0;           // 近似纯色边的标准差上限
const UNIFORM_MEAN_GAP = 14.0;     // 成对两条边的亮度差上限
const WORKERS = 4;

const state = {
    enabled: true,
    imagesDir: path.join(__dirname, 'public', 'images'),
    cacheFile: path.join(__dirname, 'dedup_cache.json'),
    threshold: DEFAULT_THRESHOLD
};

/** filename -> { mtimeMs, size, width, height, sha256, stretch:{phash,embed}, cover:{phash,embed} } */
const entries = new Map();
let cacheLoaded = false;
let primePromise = null;
let saveTimer = null;
let saveChain = Promise.resolve();

function configure(options = {}) {
    if (options.imagesDir) state.imagesDir = options.imagesDir;
    if (options.cacheFile) state.cacheFile = options.cacheFile;
    if (typeof options.enabled === 'boolean') state.enabled = options.enabled;
    if (Number.isFinite(options.threshold)) state.threshold = options.threshold;
}

function getStatus() {
    return {
        enabled: state.enabled,
        threshold: state.threshold,
        indexed: entries.size,
        algorithm: ALGO_NAME
    };
}

// ==================== 基础工具 ====================

function filenameOf(imageUrl) {
    const raw = String(imageUrl || '').trim();
    if (!raw) return '';
    return path.basename(raw);
}

async function statOf(filePath) {
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return null;
        return { mtimeMs: Math.round(stat.mtimeMs), size: stat.size };
    } catch (error) {
        return null;
    }
}

async function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = require('fs').createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function round4(value) {
    return Math.round(value * 10000) / 10000;
}

// ==================== DCT / 指纹 ====================

const dctCache = new Map();

function dctMatrix(n) {
    let mat = dctCache.get(n);
    if (mat) return mat;
    mat = new Float64Array(n * n);
    for (let k = 0; k < n; k++) {
        const scale = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
        for (let i = 0; i < n; i++) {
            mat[k * n + i] = scale * Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n));
        }
    }
    dctCache.set(n, mat);
    return mat;
}

/** 二维 DCT 后取左上 k x k 低频块（分离式实现：先横后纵，只算需要的行） */
function dctLowBlock(px, n, k) {
    const mat = dctMatrix(n);
    const tmp = new Float64Array(k * n);
    for (let a = 0; a < k; a++) {
        const base = a * n;
        for (let j = 0; j < n; j++) {
            let sum = 0;
            for (let i = 0; i < n; i++) sum += mat[base + i] * px[i * n + j];
            tmp[a * n + j] = sum;
        }
    }
    const out = new Float64Array(k * k);
    for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
            const colBase = b * n;
            let sum = 0;
            for (let j = 0; j < n; j++) sum += tmp[a * n + j] * mat[colBase + j];
            out[a * k + b] = sum;
        }
    }
    return out;
}

function medianOf(values) {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 64x64 灰度 -> 256 位感知哈希（'0'/'1' 字符串，便于直接比较汉明距离） */
function phashOf(gray) {
    const n = HASH_SIDE;
    const px = new Float64Array(n * n);
    for (let i = 0; i < px.length; i++) px[i] = gray[i];
    const low = dctLowBlock(px, n, HASH_SIZE);
    const median = medianOf(low);
    let bits = '';
    for (let i = 0; i < low.length; i++) bits += low[i] > median ? '1' : '0';
    return bits;
}

/** 16x16 灰度 -> 去均值单位化向量（点积即余弦相似度） */
function embedOf(gray) {
    const vec = new Float64Array(gray.length);
    let mean = 0;
    for (let i = 0; i < vec.length; i++) {
        vec[i] = gray[i];
        mean += gray[i];
    }
    mean /= vec.length;
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
        vec[i] -= mean;
        norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    const out = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        out[i] = norm > 0 ? round4(vec[i] / norm) : 0;
    }
    return out;
}

function rowStats(data, width, y) {
    const base = y * width;
    let sum = 0;
    let sumSq = 0;
    for (let x = 0; x < width; x++) {
        const v = data[base + x];
        sum += v;
        sumSq += v * v;
    }
    const mean = sum / width;
    return { mean, std: Math.sqrt(Math.max(0, sumSq / width - mean * mean)) };
}

function colStats(data, width, height, x) {
    let sum = 0;
    let sumSq = 0;
    for (let y = 0; y < height; y++) {
        const v = data[y * width + x];
        sum += v;
        sumSq += v * v;
    }
    const mean = sum / height;
    return { mean, std: Math.sqrt(Math.max(0, sumSq / height - mean * mean)) };
}

/** 只裁"成对的近纯色边"（上下同时纯色、左右同时纯色），避免把天空一类单边背景裁掉 */
function trimLetterbox(data, width, height) {
    if (width < 16 || height < 16) return { left: 0, top: 0, width, height };

    const maxV = Math.max(1, Math.floor(height * 0.22));
    const maxH = Math.max(1, Math.floor(width * 0.22));

    let top = 0;
    while (top < maxV) {
        const a = rowStats(data, width, top);
        const b = rowStats(data, width, height - 1 - top);
        if (!(a.std < UNIFORM_STD && b.std < UNIFORM_STD)) break;
        if (Math.abs(a.mean - b.mean) > UNIFORM_MEAN_GAP) break;
        top++;
    }

    let left = 0;
    while (left < maxH) {
        const a = colStats(data, width, height, left);
        const b = colStats(data, width, height, width - 1 - left);
        if (!(a.std < UNIFORM_STD && b.std < UNIFORM_STD)) break;
        if (Math.abs(a.mean - b.mean) > UNIFORM_MEAN_GAP) break;
        left++;
    }

    if (top < 3 && left < 3) return { left: 0, top: 0, width, height };

    const box = { left, top, width: width - 2 * left, height: height - 2 * top };
    if (box.width < 8 || box.height < 8) return { left: 0, top: 0, width, height };
    return box;
}

function extractRegion(data, width, box) {
    const out = Buffer.alloc(box.width * box.height);
    for (let y = 0; y < box.height; y++) {
        const srcStart = (box.top + y) * width + box.left;
        data.copy(out, y * box.width, srcStart, srcStart + box.width);
    }
    return out;
}

/** 灰度预览：自动按 EXIF 转正 + 压到 256 以内 + 去 alpha，整张图只解码这一遍 */
async function grayscalePreview(input) {
    const { data, info } = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const channels = info.channels || 1;
    if (channels === 1) return { data, width: info.width, height: info.height };

    // 兜底：理论上 flatten + grayscale 后已是单通道
    const pixels = info.width * info.height;
    const out = Buffer.alloc(pixels);
    for (let i = 0; i < pixels; i++) out[i] = data[i * channels];
    return { data: out, width: info.width, height: info.height };
}

/** 两种归一化各自缩到 64x64 / 16x16：fill=拉伸，cover=居中裁切 */
async function resampleVariants(raw, width, height) {
    const make = (size, fit) => sharp(raw, { raw: { width, height, channels: 1 } })
        .resize(size, size, { fit, kernel: 'lanczos3' })
        .raw()
        .toBuffer();

    const [stretch64, cover64, stretch16, cover16] = await Promise.all([
        make(HASH_SIDE, 'fill'),
        make(HASH_SIDE, 'cover'),
        make(EMBED_SIZE, 'fill'),
        make(EMBED_SIZE, 'cover')
    ]);
    return { stretch64, cover64, stretch16, cover16 };
}

/**
 * 计算一张图的指纹。
 * input 可以是文件路径或 Buffer；filePath 非空时直接对文件算 sha256。
 */
async function fingerprint(input, filePath) {
    const preview = await grayscalePreview(input);
    const box = trimLetterbox(preview.data, preview.width, preview.height);
    const raw = extractRegion(preview.data, preview.width, box);
    const variants = await resampleVariants(raw, box.width, box.height);

    return {
        width: box.width,
        height: box.height,
        sha256: filePath ? await sha256File(filePath) : sha256Buffer(input),
        stretch: { phash: phashOf(variants.stretch64), embed: embedOf(variants.stretch16) },
        cover: { phash: phashOf(variants.cover64), embed: embedOf(variants.cover16) }
    };
}

// ==================== 相似度 ====================

function phashSimilarity(a, b) {
    const len = Math.min(a.length, b.length);
    if (!len) return 0;
    let same = 0;
    for (let i = 0; i < len; i++) if (a[i] === b[i]) same++;
    return same / len;
}

function embedSimilarity(a, b) {
    const len = Math.min(a.length, b.length);
    let dot = 0;
    for (let i = 0; i < len; i++) dot += a[i] * b[i];
    return dot;
}

/** 与 Python 版 similarity_matrices 的取值方式一致 */
function similarity(query, candidate) {
    const phStretch = phashSimilarity(query.stretch.phash, candidate.stretch.phash);
    const phCover = phashSimilarity(query.cover.phash, candidate.cover.phash);
    const emStretch = embedSimilarity(query.stretch.embed, candidate.stretch.embed);
    const emCover = embedSimilarity(query.cover.embed, candidate.cover.embed);
    const emCross = Math.max(
        embedSimilarity(query.stretch.embed, candidate.cover.embed),
        embedSimilarity(query.cover.embed, candidate.stretch.embed)
    );

    const phashBest = Math.max(phStretch, phCover);
    const embedBest = Math.max(emStretch, emCover, emCross);
    const combined = 0.62 * phashBest + 0.38 * embedBest;
    return { phashBest, embedBest, score: Math.max(phashBest, combined) };
}

function isHit(sim, threshold) {
    if (sim.phashBest >= threshold) return true;
    return sim.phashBest >= threshold - PHASH_MARGIN && sim.embedBest >= threshold;
}

/** 拿一张指纹和图鉴现有条目逐一比对 */
function compareWithGallery(fp, birds, excludeId) {
    const threshold = state.threshold;
    const excluded = (excludeId === null || excludeId === undefined || excludeId === '')
        ? null
        : Number(excludeId);

    let scanned = 0;
    let best = null;
    let hit = null;

    for (const bird of birds) {
        if (!bird) continue;
        if (excluded !== null && Number(bird.id) === excluded) continue;

        const filename = filenameOf(bird.imageUrl);
        const entry = filename ? entries.get(filename) : null;
        if (!entry) continue;
        scanned++;

        let sim;
        let method;
        let matched;
        if (fp.sha256 && entry.sha256 && fp.sha256 === entry.sha256) {
            sim = { phashBest: 1, embedBest: 1, score: 1 };
            method = 'exact';
            matched = true;
        } else {
            sim = similarity(fp, entry);
            matched = isHit(sim, threshold);
            method = sim.phashBest >= threshold ? 'phash' : 'embed';
        }

        const candidate = {
            score: sim.score,
            similarity: round4(sim.score),
            phashSimilarity: round4(sim.phashBest),
            embedSimilarity: round4(sim.embedBest),
            method,
            bird: { id: bird.id, name: bird.name, imageUrl: bird.imageUrl }
        };

        if (!best || candidate.score > best.score) best = candidate;
        if (matched && (!hit || candidate.score > hit.score)) hit = candidate;
    }

    return {
        duplicate: !!hit,
        similarity: hit ? hit.similarity : (best ? best.similarity : 0),
        phashSimilarity: hit ? hit.phashSimilarity : (best ? best.phashSimilarity : 0),
        embedSimilarity: hit ? hit.embedSimilarity : (best ? best.embedSimilarity : 0),
        method: hit ? hit.method : null,
        match: hit ? hit.bird : null,
        closest: best ? best.bird : null,
        threshold,
        scanned,
        indexed: entries.size
    };
}

// ==================== 指纹缓存 ====================

function isUsableEntry(entry) {
    return !!entry && typeof entry === 'object'
        && typeof entry.sha256 === 'string' && entry.sha256.length > 0
        && Number.isFinite(entry.mtimeMs) && Number.isFinite(entry.size)
        && !!entry.stretch && !!entry.cover
        && typeof entry.stretch.phash === 'string' && typeof entry.cover.phash === 'string'
        && Array.isArray(entry.stretch.embed) && Array.isArray(entry.cover.embed);
}

async function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;
    try {
        const raw = await fs.readFile(state.cacheFile, 'utf8');
        const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
        if (!parsed || parsed.version !== CACHE_VERSION
            || parsed.algorithm !== ALGO_NAME || parsed.algoVersion !== ALGO_VERSION) {
            return;
        }
        const stored = (parsed.entries && typeof parsed.entries === 'object') ? parsed.entries : {};
        for (const [filename, entry] of Object.entries(stored)) {
            if (isUsableEntry(entry)) entries.set(filename, entry);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[dedup] 读取指纹缓存失败，将重新计算：', error.message);
        }
    }
}

/** 原子写 + 串行化，避免并发写坏缓存文件 */
function saveCache() {
    saveChain = saveChain
        .then(async () => {
            const payload = JSON.stringify({
                version: CACHE_VERSION,
                algorithm: ALGO_NAME,
                algoVersion: ALGO_VERSION,
                entries: Object.fromEntries(entries)
            });
            const tmp = `${state.cacheFile}.tmp`;
            await fs.writeFile(tmp, payload, 'utf8');
            await fs.rename(tmp, state.cacheFile);
        })
        .catch(error => {
            console.warn('[dedup] 写入指纹缓存失败：', error.message);
        });
    return saveChain;
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveCache();
    }, 1500);
    if (saveTimer.unref) saveTimer.unref();
}

// ==================== 指纹索引 ====================

/** 让索引与当前图鉴对齐：缺的补算、图鉴里没有的清掉 */
async function syncIndex(birds) {
    const wanted = new Set();
    for (const bird of birds) {
        const filename = filenameOf(bird && bird.imageUrl);
        if (filename) wanted.add(filename);
    }

    const jobs = [];
    for (const filename of wanted) {
        const fullPath = path.join(state.imagesDir, filename);
        const stat = await statOf(fullPath);
        if (!stat) continue;                                  // 图鉴里引用了但文件不在，跳过
        const entry = entries.get(filename);
        if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size
            && entry.stretch && entry.stretch.phash) {
            continue;
        }
        jobs.push({ filename, fullPath, stat });
    }

    for (const filename of Array.from(entries.keys())) {
        if (!wanted.has(filename)) entries.delete(filename);
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(WORKERS, jobs.length) }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++];
            try {
                const fp = await fingerprint(job.fullPath, job.fullPath);
                entries.set(job.filename, {
                    mtimeMs: job.stat.mtimeMs,
                    size: job.stat.size,
                    width: fp.width,
                    height: fp.height,
                    sha256: fp.sha256,
                    stretch: fp.stretch,
                    cover: fp.cover
                });
            } catch (error) {
                console.warn(`[dedup] 跳过无法解析的图片 ${job.filename}：`, error.message);
            }
        }
    });
    await Promise.all(workers);

    await saveCache();
    return { scanned: wanted.size, computed: jobs.length, indexed: entries.size };
}

/** 首次查重/预热时把图鉴指纹补齐；并发调用共享同一个 Promise */
function ensurePrimed(birds) {
    if (!primePromise) {
        primePromise = (async () => {
            await loadCache();
            return await syncIndex(birds);
        })().catch(error => {
            primePromise = null;   // 失败后允许下次重试
            throw error;
        });
    }
    return primePromise;
}

/** 启动时后台预热；失败不影响服务启动，第一次查重会再试一次 */
async function warmup(birds) {
    const info = await ensurePrimed(birds);
    return { ...info, threshold: state.threshold };
}

// ==================== 对外接口 ====================

function disabledResult() {
    return {
        duplicate: false,
        similarity: 0,
        phashSimilarity: 0,
        embedSimilarity: 0,
        method: null,
        match: null,
        closest: null,
        threshold: state.threshold,
        scanned: 0,
        indexed: entries.size
    };
}

/** 查重：内存里的图片（上传前预检） */
async function checkBuffer(buffer, birds, excludeId = null) {
    if (!state.enabled) return disabledResult();
    await ensurePrimed(birds);
    const fp = await fingerprint(buffer, null);
    return compareWithGallery(fp, birds, excludeId);
}

/** 查重：已落盘的图片（提交阶段复核）；顺带把指纹带出来，成功后可直接入索引 */
async function checkFile(filePath, birds, excludeId = null) {
    if (!state.enabled) return { ...disabledResult(), fingerprint: null, stat: null };
    await ensurePrimed(birds);
    const fp = await fingerprint(filePath, filePath);
    const stat = await statOf(filePath);
    return { ...compareWithGallery(fp, birds, excludeId), fingerprint: fp, stat };
}

/** 把一张图的指纹写进索引（新图上传成功、编辑换图后调用） */
function remember(filename, fingerprintValue, stat) {
    const key = filenameOf(filename);
    if (!key || !fingerprintValue) return;
    entries.set(key, {
        mtimeMs: stat ? stat.mtimeMs : 0,
        size: stat ? stat.size : 0,
        width: fingerprintValue.width,
        height: fingerprintValue.height,
        sha256: fingerprintValue.sha256,
        stretch: fingerprintValue.stretch,
        cover: fingerprintValue.cover
    });
    scheduleSave();
}

/** 从磁盘重算某张图的指纹并入索引（编辑换图后调用） */
async function ingestFile(filename) {
    if (!state.enabled) return null;
    const key = filenameOf(filename);
    if (!key) return null;
    const fullPath = path.join(state.imagesDir, key);
    const stat = await statOf(fullPath);
    if (!stat) return null;
    const fp = await fingerprint(fullPath, fullPath);
    remember(key, fp, stat);
    return fp;
}

/** 图片被删除/替换后从索引里摘掉 */
function forget(filename) {
    const key = filenameOf(filename);
    if (!key) return;
    if (entries.delete(key)) scheduleSave();
}

module.exports = {
    configure,
    getStatus,
    warmup,
    checkBuffer,
    checkFile,
    remember,
    ingestFile,
    forget,
    fingerprint
};
