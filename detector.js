/**
 * detector.js —— 夜鹭 YOLO 单类检测器
 *
 * 职责：加载 models/yelu.onnx，对上传的图片 Buffer 做 letterbox 预处理、推理、YOLO 后处理与 NMS，
 *       返回"是否检出夜鹭"的判定结果。模型缺失/加载失败时不影响主服务，调用方走静默降级。
 *
 * 对外接口：
 *   init()                 预加载模型（可选，懒加载也行）
 *   isReady()              模型是否可用
 *   status()               模型元信息 + 缓存条数
 *   detect(buffer)         Buffer -> 检测结果
 *   close()                释放 session
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'models', 'detector.json');
const CACHE_PATH = path.join(ROOT_DIR, 'recognition_cache.json');

const DEFAULTS = {
    model: 'yelu.onnx',
    inputSize: 640,
    letterbox: true,
    padValue: 114,
    normalize: { ratio: 1 / 255, mean: [0, 0, 0] },
    // 类别分数通道的激活方式：'none' | 'sigmoid' | 'auto'
    // 'auto' 只采样候选框在 argmax 类别上的最高分，不碰框参数通道（框天然 >1，会误判）
    activation: 'auto',
    confThreshold: 0.25,
    iouThreshold: 0.45,
    maxDetections: 20,
    classNames: ['夜鹭'],
    nightHeronClassIds: [0],
    outputLayout: 'auto',
    timings: { warmup: true, maxConcurrent: 2, timeoutMs: 5000 }
};

// ---------------------------------------------------------------- 状态

let config = null;
let session = null;
let ort = null;
let sharp = null;
let loading = null;          // Promise，避免并发重复加载
let lastError = null;

const memCache = new Map();  // sha1 -> 结果对象（LRU，最多 500 条）
const MEM_CACHE_MAX = 500;
let cacheDirty = false;
let cacheFlushTimer = null;

// ---------------------------------------------------------------- 工具

function loadConfig() {
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.warn('[detector] 读取 detector.json 失败，使用默认配置：', e.message);
        }
    }
    const merged = { ...DEFAULTS, ...user };
    merged.normalize = { ...DEFAULTS.normalize, ...(user.normalize || {}) };
    merged.timings = { ...DEFAULTS.timings, ...(user.timings || {}) };
    merged.modelPath = path.join(ROOT_DIR, 'models', merged.model);
    return merged;
}

function sha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

/** 带超时的 Promise 包装 */
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 简单信号量，限制并发推理数，避免阻塞事件循环过久 */
class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.queue = [];
    }
    async acquire() {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        await new Promise(resolve => this.queue.push(resolve));
        this.active++;
    }
    release() {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
    }
}
let semaphore = null;

// ---------------------------------------------------------------- 加载

async function init() {
    if (session) return session;
    if (loading) return loading;

    loading = (async () => {
        config = config || loadConfig();
        semaphore = semaphore || new Semaphore(config.timings.maxConcurrent);

        if (!fs.existsSync(config.modelPath)) {
            throw new Error(`模型文件不存在：${config.modelPath}`);
        }

        if (!ort) {
            ort = require('onnxruntime-node');
        }
        if (!sharp) {
            sharp = require('sharp');
        }

        const opts = {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
            intraOpNumThreads: Math.max(1, Math.min(4, require('os').cpus().length - 1 || 1))
        };

        session = await ort.InferenceSession.create(config.modelPath, opts);

        // 用模型自身元信息校验配置，避免输入尺寸写错时静默产出垃圾框
        const inputMeta = session.inputMetadata && session.inputMetadata[0];
        if (inputMeta && Array.isArray(inputMeta.dimensions)) {
            const dims = inputMeta.dimensions;
            const h = dims[2], w = dims[3];
            if (typeof h === 'number' && typeof w === 'number' && (h !== config.inputSize || w !== config.inputSize)) {
                console.warn(`[detector] 配置 inputSize=${config.inputSize}，但模型输入为 ${w}x${h}，改用模型尺寸`);
                config.inputSize = Math.max(h, w);
            }
        }

        if (config.timings.warmup) {
            try {
                const size = config.inputSize;
                const zero = new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]);
                const inputName = session.inputNames[0];
                await session.run({ [inputName]: zero });
            } catch (e) {
                console.warn('[detector] warmup 失败（不影响使用）：', e.message);
            }
        }

        console.log(`[detector] 模型已加载：${path.basename(config.modelPath)}，输入 ${config.inputSize}x${config.inputSize}，类别 ${config.classNames.join('/')}`);

        // 缓存以图片 sha1 为键、不含模型指纹：换了模型后旧结果会串味。
        // 检测是纯派生数据，重新推理成本很低，因此每次加载模型都清空缓存从头算。
        memCache.clear();
        scheduleCacheFlush();

        return session;
    })();

    try {
        return await loading;
    } catch (e) {
        lastError = e.message;
        console.error('[detector] 模型加载失败，检测功能将不可用：', e.message);
        loading = null;          // 允许后续重试
        throw e;
    }
}

// ---------------------------------------------------------------- 缓存

// 说明：缓存以图片内容 sha1 为键，只在同一次模型加载的生命周期内有效。
// 每次 init() 成功加载模型都会清空缓存，避免换模型后沿用旧模型的判定。

function scheduleCacheFlush() {
    cacheDirty = true;
    if (cacheFlushTimer) return;
    cacheFlushTimer = setTimeout(async () => {
        cacheFlushTimer = null;
        if (!cacheDirty) return;
        cacheDirty = false;
        try {
            const obj = {};
            for (const [k, v] of memCache) obj[k] = v;
            const tmp = CACHE_PATH + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
            await fsp.rename(tmp, CACHE_PATH);   // 原子替换，避免半截文件
        } catch (e) {
            console.warn('[detector] 缓存写入失败：', e.message);
        }
    }, 2000);
}

function putCache(key, value) {
    memCache.set(key, value);
    if (memCache.size > MEM_CACHE_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
    }
    scheduleCacheFlush();
}

// ---------------------------------------------------------------- 预处理

/**
 * letterbox：等比缩放 + 居中补边，保持长宽比不变形（YOLO 训练时就是这么做的）
 * 返回 NCHW Float32Array 与把模型坐标映射回原图所需的比例/偏移
 */
async function preprocess(buffer) {
    const size = config.inputSize;
    const meta = await sharp(buffer, { failOn: 'none' })
        .rotate()                                  // 按 EXIF 旋正
        .flatten({ background: '#ffffff' })         // 透明 PNG 铺白底
        .toColorspace('srgb')
        .metadata();

    const srcW = meta.width;
    const srcH = meta.height;
    if (!srcW || !srcH) throw new Error('无法解析图片尺寸');

    let newW, newH;
    if (config.letterbox) {
        const scale = Math.min(size / srcW, size / srcH);
        newW = Math.max(1, Math.round(srcW * scale));
        newH = Math.max(1, Math.round(srcH * scale));
    } else {
        newW = size;
        newH = size;
    }

    const { data } = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .toColorspace('srgb')
        .resize(newW, newH, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const channels = 3;
    const padX = Math.floor((size - newW) / 2);
    const padY = Math.floor((size - newH) / 2);
    const pad = config.padValue;

    // 整张画布先填成 padValue，再把缩放后的图像贴到中心
    const total = channels * size * size;
    const plane = size * size;
    const input = new Float32Array(total);
    const padNorm = (pad / 255 - config.normalize.mean[0]) * config.normalize.ratio;
    input.fill(padNorm);

    const ratio = config.normalize.ratio;
    const mean = config.normalize.mean;

    for (let y = 0; y < newH; y++) {
        const dstY = y + padY;
        if (dstY < 0 || dstY >= size) continue;
        for (let x = 0; x < newW; x++) {
            const dstX = x + padX;
            if (dstX < 0 || dstX >= size) continue;
            const srcIdx = (y * newW + x) * channels;
            const dstIdx = dstY * size + dstX;
            for (let c = 0; c < channels; c++) {
                const v = data[srcIdx + c];
                input[c * plane + dstIdx] = (v - mean[c]) * ratio;
            }
        }
    }

    // 把模型坐标还原到原图：先减 pad，再除以缩放比
    const scale = config.letterbox ? Math.min(size / srcW, size / srcH) : null;
    const restore = config.letterbox
        ? { x: (v) => (v - padX) / scale, y: (v) => (v - padY) / scale, scale }
        : { x: (v) => v * srcW / size, y: (v) => v * srcH / size, scale: srcW / size };

    return { tensor: input, size, srcW, srcH, padX, padY, restore, newW, newH };
}

// ---------------------------------------------------------------- 后处理

function iou(a, b) {    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union <= 0 ? 0 : inter / union;
}

function nms(boxes, iouThreshold) {
    boxes.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const box of boxes) {
        let ok = true;
        for (const k of kept) {
            if (k.cls === box.cls && iou(k, box) > iouThreshold) { ok = false; break; }
        }
        if (ok) kept.push(box);
    }
    return kept;
}

/**
 * 判断类别分数是否需要过 Sigmoid。
 *
 * 关键：只能看【类别分数】，绝不能看整个张量。
 * YOLO 的框参数（cx,cy,w,h）本身就是几十到几百的像素值，拿它们判断必然误判成
 * "未激活 logits"；一旦对全张量套 Sigmoid，框会被压成 1.0，产出满屏退化小框。
 */
function needsSigmoid(scores) {
    if (config.activation === 'sigmoid') return true;
    if (config.activation === 'none') return false;

    const step = Math.max(1, Math.floor(scores.length / 4096));
    let max = -Infinity, min = Infinity;
    for (let i = 0; i < scores.length; i += step) {
        const v = scores[i];
        if (!Number.isFinite(v)) continue;
        if (v > max) max = v;
        if (v < min) min = v;
    }
    return max > 1.0001 || min < -0.0001;
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * 把通道优先的 [1, C, N] 重排为逐候选连续的 [N, C]。
 * ultralytics 导出的内存布局是第 c 个通道第 i 个候选位于 c*N+i，
 * 必须转成候选连续才能正确取到框参数与类别分数。
 */
function toCandidates(dims, data, layout) {
    const d1 = dims[1], d2 = dims[2];

    // auto：候选数远多于通道数时 dims[1] 是通道数，否则说明已是 [1, N, C]
    let channelFirst;
    if (layout === 'yolo') channelFirst = true;
    else if (layout === 'yolo-transposed') channelFirst = false;
    else channelFirst = d1 < d2;

    const channels = channelFirst ? d1 : d2;
    const count = channelFirst ? d2 : d1;
    const rows = new Float32Array(count * channels);

    if (channelFirst) {
        for (let c = 0; c < channels; c++) {
            const src = c * count;
            for (let i = 0; i < count; i++) rows[i * channels + c] = data[src + i];
        }
    } else {
        rows.set(data.subarray(0, count * channels));
    }
    return { rows, channels, count };
}

/** 把原始输出张量解码为 xywh 框数组（模型坐标系） */
function decode(output, outMeta, layout) {
    const dims = outMeta.dimensions;
    const data = output.data;

    if (dims.length !== 3) throw new Error(`不支持的输出维度：${JSON.stringify(dims)}`);

    // [1, N, 6]：end-to-end / 已做 NMS 的导出，x1,y1,x2,y2,score,cls
    const isEndToEnd = dims[2] === 6 && dims[1] > 100 && layout !== 'yolo-transposed' && layout !== 'yolo';

    if (isEndToEnd) {
        const n = dims[1];
        const rawScores = new Float32Array(n);
        for (let i = 0; i < n; i++) rawScores[i] = data[i * 6 + 4];
        const act = needsSigmoid(rawScores) ? sigmoid : (x) => x;

        const boxes = [];
        for (let i = 0; i < n; i++) {
            const o = i * 6;
            const score = act(rawScores[i]);
            if (score < config.confThreshold) continue;
            const x1 = data[o], y1 = data[o + 1], x2 = data[o + 2], y2 = data[o + 3];
            boxes.push({
                x: Math.min(x1, x2), y: Math.min(y1, y2),
                w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
                score, cls: Math.round(data[o + 5])
            });
        }
        return { boxes, preNmsed: true };
    }

    // ultralytics 标准导出 [1, 4+nc, N]，通道优先，需重排为逐候选连续
    const { rows, channels, count } = toCandidates(dims, data, layout);

    // 通道分配：4 个框参数 + 若干类别分数；若比 4+nc 多一个通道则含 objectness
    const nc = (config.classNames && config.classNames.length) || 1;
    let hasObjectness = false;
    if (channels === 4 + nc + 1) hasObjectness = true;
    else if (channels !== 4 + nc) {
        // 通道数与配置的类别数不符，按剩余通道全部当类别处理
        console.warn(`[detector] 输出通道数 ${channels} 与类别数 ${nc} 不符，按 ${channels - 4} 类解析`);
    }

    const clsBase = 4 + (hasObjectness ? 1 : 0);
    const numCls = Math.max(1, channels - clsBase);

    // 关键：先逐候选取类别最高分，再用这些分数判断激活方式。
    // 若拿整个张量（含几十到几百像素的框参数）判断，必然误判成 logits。
    const bestCls = new Int32Array(count);
    const bestScores = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const off = i * channels + clsBase;
        let bs = -Infinity, bc = 0;
        for (let c = 0; c < numCls; c++) {
            const s = rows[off + c];
            if (s > bs) { bs = s; bc = c; }
        }
        bestScores[i] = bs;
        bestCls[i] = bc;
    }

    const useSigmoid = needsSigmoid(bestScores);
    const act = useSigmoid ? sigmoid : (x) => x;
    if (useSigmoid) console.log('[detector] 类别分数超出 [0,1]，判定为未激活 logits，已应用 Sigmoid');

    const boxes = [];
    for (let i = 0; i < count; i++) {
        const off = i * channels;
        const w = rows[off + 2];
        const h = rows[off + 3];
        if (!(w >= 1) || !(h >= 1)) continue;      // 丢弃宽高不足 1 像素的退化框

        let score = act(bestScores[i]);
        if (hasObjectness) {
            const obj = act(rows[off + 4]);
            if (obj < config.confThreshold) continue;
            score *= obj;
        }
        if (score < config.confThreshold) continue;

        boxes.push({
            x: rows[off] - w / 2,
            y: rows[off + 1] - h / 2,
            w, h,
            score, cls: bestCls[i]
        });
    }
    return { boxes, preNmsed: false };
}

// ---------------------------------------------------------------- 主流程

/** 判定结果里只关心"有没有夜鹭"，所以这里同时给出 found / pass / verdict */
function buildVerdict(detections) {
    const ids = new Set(config.nightHeronClassIds);
    const nightHerons = detections.filter(d => ids.has(d.cls));
    const found = nightHerons.length > 0;
    const top = nightHerons[0] || detections[0] || null;
    return {
        found,
        score: top ? Number(top.score.toFixed(4)) : 0,
        pass: found,
        verdict: found ? '已检出夜鹭，直接通过' : '未检出夜鹭，夜师傅今天出什么COS~',
        label: top ? (config.classNames[top.cls] || `class_${top.cls}`) : null,
        detections
    };
}

/**
 * 检测主入口
 * @param {Buffer} buffer 图片二进制
 * @returns {Promise<object>} 检测结果
 */
async function detect(buffer) {
    if (!buffer || !buffer.length) throw new Error('图片数据为空');

    const key = sha1(buffer);
    const cached = memCache.get(key);
    if (cached) {
        // LRU：命中后挪到末尾
        memCache.delete(key);
        memCache.set(key, cached);
        return { ...cached, cached: true };
    }

    await init();

    const pre = await preprocess(buffer);
    const inputName = session.inputNames[0];
    const tensor = new ort.Tensor('float32', pre.tensor, [1, 3, pre.size, pre.size]);

    await semaphore.acquire();
    let outputs;
    try {
        outputs = await withTimeout(
            session.run({ [inputName]: tensor }),
            config.timings.timeoutMs,
            '推理'
        );
    } finally {
        semaphore.release();
    }

    // 输出张量校验：必须是单输出的 [1, C, N] 检测头。
    // 若误放入分割/姿态等原始导出（多输出），outputNames[0] 可能是 [1,64,80,80] 这类
    // 特征图，强行按候选框解析会得到满屏假检出。宁可明确报错，也不要产出垃圾判定。
    if (session.outputNames.length !== 1) {
        throw new Error(
            `模型有 ${session.outputNames.length} 个输出（${session.outputNames.join(', ')}），`
            + `本检测器仅支持单输出检测模型。请用 yolo export format=onnx 导出 detect 任务的模型。`
        );
    }

    const outName = session.outputNames[0];
    const out = outputs[outName];
    const outDims = out.dims || (session.outputMetadata && session.outputMetadata[0] && session.outputMetadata[0].dimensions);
    if (!Array.isArray(outDims) || outDims.length !== 3 || outDims[0] !== 1) {
        throw new Error(
            `不支持的输出形状 ${JSON.stringify(outDims)}，期望 [1, 4+类别数, 候选数]。`
        );
    }

    const { boxes, preNmsed } = decode(out, { dimensions: outDims }, config.outputLayout);
    const kept = (preNmsed ? boxes : nms(boxes, config.iouThreshold))
        .slice(0, config.maxDetections)
        .map(b => {
            // 还原到原图坐标，并夹到图片范围内
            const x = Math.max(0, Math.min(pre.srcW, pre.restore.x(b.x)));
            const y = Math.max(0, Math.min(pre.srcH, pre.restore.y(b.y)));
            const x2 = Math.max(0, Math.min(pre.srcW, pre.restore.x(b.x + b.w)));
            const y2 = Math.max(0, Math.min(pre.srcH, pre.restore.y(b.y + b.h)));
            return {
                x: Math.round(x),
                y: Math.round(y),
                w: Math.round(Math.max(0, x2 - x)),
                h: Math.round(Math.max(0, y2 - y)),
                score: Number(b.score.toFixed(4)),
                cls: b.cls,
                label: config.classNames[b.cls] || `class_${b.cls}`
            };
        });

    const result = {
        ...buildVerdict(kept),
        image: { width: pre.srcW, height: pre.srcH },
        model: {
            file: path.basename(config.modelPath),
            inputSize: pre.size,
            confThreshold: config.confThreshold,
            iouThreshold: config.iouThreshold
        },
        cached: false
    };

    putCache(key, result);
    return result;
}

async function status() {
    let ready = false;
    try {
        await init();
        ready = !!session;
    } catch (e) {
        ready = false;
    }
    return {
        ready,
        error: ready ? null : lastError,
        modelFile: config ? path.basename(config.modelPath) : null,
        inputSize: config ? config.inputSize : null,
        classNames: config ? config.classNames : [],
        confThreshold: config ? config.confThreshold : null,
        cacheSize: memCache.size
    };
}

function isReady() {
    return !!session;
}

async function close() {
    if (session) {
        try { await session.release(); } catch (e) { /* ignore */ }
        session = null;
    }
    if (cacheDirty) {
        if (cacheFlushTimer) { clearTimeout(cacheFlushTimer); cacheFlushTimer = null; }
        try {
            const obj = {};
            for (const [k, v] of memCache) obj[k] = v;
            await fsp.writeFile(CACHE_PATH, JSON.stringify(obj), 'utf8');
        } catch (e) { /* ignore */ }
    }
}

module.exports = { init, isReady, status, detect, close, preprocess, _config: () => config };
