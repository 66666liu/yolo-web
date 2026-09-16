#!/usr/bin/env node
/**
 * 图片查重接口冒烟测试（只读为主，不污染图鉴）
 *
 * 覆盖：
 *   1. 图鉴里已有的图      -> duplicate=true
 *   2. 已有图缩放后的副本  -> duplicate=true（证明能扛住尺寸/比例变化）
 *   3. 全新的合成图        -> duplicate=false
 *   4. 直接提交重复图      -> 服务端 409，且图鉴张数不变（不占额度、不留孤儿文件）
 *
 * 用法：
 *   node server.js              # 另开一个终端先起服务
 *   node scripts/smoke_dedup_api.js [http://127.0.0.1:3000]
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');

let failures = 0;

function check(label, ok, detail) {
    console.log(`${ok ? '  [OK]  ' : '  [FAIL]'} ${label}${detail ? ` -> ${detail}` : ''}`);
    if (!ok) failures++;
}

async function postImage(url, buffer, filename, extraFields = {}) {
    const form = new FormData();
    form.append('image', new Blob([buffer]), filename);
    for (const [key, value] of Object.entries(extraFields)) form.append(key, value);
    const response = await fetch(url, { method: 'POST', body: form });
    let payload = null;
    try { payload = await response.json(); } catch (error) { /* 非 JSON 响应 */ }
    return { status: response.status, payload };
}

async function waitForIndex(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE}/api/dedup/status`);
            last = await response.json();
            if (last && last.indexed > 0) return last;
        } catch (error) {
            // 服务还没起来，继续等
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`等待指纹索引超时（最后状态：${JSON.stringify(last)}）`);
}

async function countBirds() {
    const response = await fetch(`${BASE}/api/birds/count`);
    const data = await response.json();
    return data.count;
}

async function main() {
    console.log(`查重冒烟测试：${BASE}`);

    const status = await waitForIndex();
    check('查重服务已就绪', status.enabled === true && status.indexed > 0,
        `已建索引 ${status.indexed} 张，阈值 ${status.threshold}`);

    // 1. 图鉴里已有的图
    const existingName = fs.readdirSync(IMAGES_DIR).find(name => name.startsWith('夜鹭-2'));
    if (!existingName) throw new Error('找不到用于测试的图鉴图片 夜鹭-2.*');
    const existingBuffer = fs.readFileSync(path.join(IMAGES_DIR, existingName));
    const exact = await postImage(`${BASE}/api/dedup/check`, existingBuffer, existingName);
    check('已有图被判为重复', exact.payload && exact.payload.duplicate === true,
        `similarity=${exact.payload && exact.payload.similarity} match=${exact.payload && exact.payload.match && exact.payload.match.name}`);

    // 2. 缩放后的副本（尺寸不同、比例不变）
    const resized = await sharp(existingBuffer).resize({ width: 320 }).jpeg({ quality: 82 }).toBuffer();
    const resizedResult = await postImage(`${BASE}/api/dedup/check`, resized, 'resized.jpg');
    check('缩放副本仍被判为重复', resizedResult.payload && resizedResult.payload.duplicate === true,
        `similarity=${resizedResult.payload && resizedResult.payload.similarity} method=${resizedResult.payload && resizedResult.payload.method}`);

    // 3. 全新的合成图（渐变噪声）
    const width = 400;
    const height = 300;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            raw[i] = (x * 3 + y) % 256;
            raw[i + 1] = (x ^ y) % 256;
            raw[i + 2] = (x * y) % 256;
        }
    }
    const fresh = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const freshResult = await postImage(`${BASE}/api/dedup/check`, fresh, 'fresh.png');
    check('新图不被判为重复', freshResult.payload && freshResult.payload.duplicate === false,
        `similarity=${freshResult.payload && freshResult.payload.similarity}`);

    // 4. 直接提交重复图 -> 409，且图鉴张数不变
    const before = await countBirds();
    const submit = await postImage(`${BASE}/api/birds`, existingBuffer, existingName, { name: '查重冒烟测试' });
    const after = await countBirds();
    check('提交重复图被服务端拒绝（409）', submit.status === 409,
        `status=${submit.status} error=${submit.payload && submit.payload.error}`);
    check('被拒后图鉴张数不变', before === after, `${before} -> ${after}`);

    console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项失败`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
    console.error('测试异常：', error.message);
    process.exit(1);
});
