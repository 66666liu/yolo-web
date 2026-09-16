const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');                                    // 流式读文件（打包 zip 用）
const { once } = require('events');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const cors = require('cors');
const sharp = require('sharp');
const detector = require('./detector');

// ==================== 配置 ====================
// 优先级：环境变量 > config.js > config.example.js 里的默认值。
// config.js 在 .gitignore 里（方便放 ADMIN_KEY_HASH），缺失时用模板兜底，开箱即用。
function loadFileConfig() {
    for (const file of ['./config', './config.example']) {
        try {
            const loaded = require(file);
            if (loaded && typeof loaded === 'object') return { config: loaded, from: `${file}.js` };
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') {
                console.warn(`[config] 读取 ${file}.js 失败：${error.message}`);
            }
        }
    }
    return { config: {}, from: '（未找到配置文件，全部用内置默认值）' };
}
const { config: FILE_CONFIG, from: CONFIG_SOURCE } = loadFileConfig();

const asInt = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
};
const asPositiveInt = (value, fallback) => {
    const n = asInt(value, fallback);
    return n > 0 ? n : fallback;
};
const asString = (value, fallback) => {
    const s = (value === undefined || value === null) ? '' : String(value).trim();
    return s === '' ? fallback : s;
};

/** 取一个配置项：环境变量 > 配置文件 > 内置默认值，并记录来源用于启动日志 */
function pick(envName, fileValue, builtinDefault) {
    if (envName && process.env[envName] !== undefined && String(process.env[envName]).trim() !== '') {
        return { value: process.env[envName], source: 'env', envName };
    }
    if (fileValue !== undefined && fileValue !== null && fileValue !== '') {
        return { value: fileValue, source: 'config.js' };
    }
    return { value: builtinDefault, source: 'default' };
}
const sourceLabel = (setting) => setting.source === 'env'
    ? `env:${setting.envName}`
    : (setting.source === 'config.js' ? CONFIG_SOURCE : 'default');

// 配置Express应用
const app = express();
const PORT_SETTING = pick('PORT', FILE_CONFIG.port, 3000);
const PORT = asPositiveInt(PORT_SETTING.value, 3000);

/**
 * 解析 trustProxy，决定 Express 信任哪一层代理。
 *
 * 默认 'loopback'：只信任本机回环上的反向代理。natapp 这类内网穿透就跑在本机，
 * 对端是 127.0.0.1/::1，Express 会把 req.ip 解析成"最右侧不可信地址"，
 * 因此客户端自己伪造 X-Forwarded-For 也无法换一个 IP 去刷上传额度。
 * 以前写死 true（信任所有代理）时，请求头里塞一个 XFF 就能绕过按 IP 的额度统计。
 * 代理不在本机时，可设为 true / 跳数 / IP 或 CIDR 列表（如 '10.0.0.0/8'）。
 */
function parseTrustProxy(raw) {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (value === '' || value === 'false') return false;
    if (value === 'true') return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value; // 'loopback' / 'linklocal' / 'uniquelocal' / IP、CIDR 列表
}
const TRUST_PROXY_SETTING = pick('TRUST_PROXY', FILE_CONFIG.trustProxy, 'loopback');
const TRUST_PROXY = asString(TRUST_PROXY_SETTING.value, 'loopback');
app.set('trust proxy', parseTrustProxy(TRUST_PROXY));

const CORS_ORIGINS = Array.isArray(FILE_CONFIG.corsOrigins)
    ? FILE_CONFIG.corsOrigins.filter(origin => typeof origin === 'string' && origin.trim())
    : [];

// 配置CORS（同源访问不经过这里，列表留空也不影响正常使用）
app.use(cors({
    origin: CORS_ORIGINS.length ? CORS_ORIGINS : false,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Authorization, X-Operation-Desc, X-Admin-Token',
    // 前端要读上传额度的响应头，跨域访问时必须显式暴露
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
    credentials: true
}));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/images', express.static(path.join(__dirname, 'public/images')));

// 解析JSON请求体
app.use(express.json());

// API缓存控制
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    next();
});

// 上传图片的体积与格式限制（体积上限来自 config.js 的 maxImageMB，前端文案由 GET /api/config 同步）
const MAX_IMAGE_MB = asPositiveInt(FILE_CONFIG.maxImageMB, 20);
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
const MAX_IMAGE_LABEL = `${MAX_IMAGE_MB}MB`;

// 仅允许这几种格式。以扩展名和真实解码结果为准，不依赖客户端 MIME
// （客户端 MIME 既可能缺失导致误杀，也可能被伪造导致漏放）。
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_EXT_LABEL = 'JPG、PNG、WebP';
// sharp 解出的真实格式名 -> 是否允许
const ALLOWED_DECODED_FORMAT = new Set(['jpeg', 'png', 'webp']);

/**
 * 用 sharp 校验文件是否为可解码的真实图片。
 * 这是必要的：仅看扩展名的话，一个改了后缀的文本文件也会被放行。
 * 返回错误文案；合法返回 null。
 */
async function validateImageContent(absPath) {
    try {
        const meta = await sharp(absPath).metadata();
        if (!meta || !ALLOWED_DECODED_FORMAT.has(meta.format)) {
            return `仅支持 ${ALLOWED_EXT_LABEL} 格式的图片`;
        }
        return null;
    } catch (e) {
        // 解不出来说明不是有效图片
        return `图片无法识别或已损坏，仅支持 ${ALLOWED_EXT_LABEL} 格式`;
    }
}

/** 校验上传文件，返回错误信息字符串；合法返回 null */
async function validateImageFile(file) {
    if (!file) return null; // 允许不带图片的编辑

    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
        return `仅支持 ${ALLOWED_EXT_LABEL} 格式的图片`;
    }
    if (file.size > MAX_IMAGE_BYTES) {
        return `图片大小不能超过 ${MAX_IMAGE_LABEL}`;
    }

    // 真正读一遍内容，挡掉改后缀的伪装文件
    return await validateImageContent(file.path);
}

// 配置Multer存储引擎
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public/images'));
    },
    filename: (req, file, cb) => {
        let ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) ext = '.jpg'; // 兜底，正常情况下进不来
        cb(null, `${uuidv4()}${ext}`);
    }
});

// 格式在 fileFilter 阶段先按扩展名拦下，避免明显非法的文件落盘；
// 内容是否真的是图片由 validateImageFile 用 sharp 复核。
const imageFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) {
        cb(null, true);
    } else {
        cb(new Error(`仅支持 ${ALLOWED_EXT_LABEL} 格式的图片`));
    }
};

const upload = multer({
    storage: storage,
    fileFilter: imageFileFilter,
    limits: { fileSize: MAX_IMAGE_BYTES } // 20MB
});

// 夜鹭检测专用：图片留在内存里交给模型，不落盘（检测是只读操作，不应产生文件）
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    fileFilter: imageFileFilter,
    limits: { fileSize: MAX_IMAGE_BYTES } // 20MB
});

// 存储操作日志和IP操作频率的文件
const operationLogPath = path.join(__dirname, 'operation_log.json');
const ipOperationsPath = path.join(__dirname, 'ip_operations.json');
// 点赞与抽卡次数（同样是按 IP 记录的运行期状态）
const likesPath = path.join(__dirname, 'likes.json');
const gachaTicketsPath = path.join(__dirname, 'gacha_tickets.json');

/**
 * 读取 JSON 文件并解析。
 * 必须手动去掉 UTF-8 BOM：Windows 的 PowerShell（Set-Content -Encoding utf8 等）
 * 写出来的文件会带 BOM，而 JSON.parse 遇到 BOM 会直接抛错 —— 对 data.json 来说
 * 就意味着图鉴被当成空数组，紧接着 saveData() 把数据覆盖掉。
 */
async function readJsonFile(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(String(raw).replace(/^\uFEFF/, ''));
}

// 初始化文件
async function initOperationFiles() {
    for (const filePath of [operationLogPath, ipOperationsPath, likesPath, gachaTicketsPath]) {
        try {
            await fs.access(filePath);
        } catch (error) {
            // 点赞与抽卡次数是对象，其余是数组
            const initial = (filePath === likesPath || filePath === gachaTicketsPath) ? {} : [];
            await fs.writeFile(filePath, JSON.stringify(initial));
        }
    }
}

// 读取操作日志
async function readOperationLog() {
    try {
        return await readJsonFile(operationLogPath);
    } catch (error) {
        console.error('Error reading operation log:', error);
        return [];
    }
}

// 写入操作日志
async function writeOperationLog(logs) {
    try {
        await fs.writeFile(operationLogPath, JSON.stringify(logs));
    } catch (error) {
        console.error('Error writing operation log:', error);
    }
}

// 获取客户端IP - 针对natapp穿透优化版本
function getClientIp(req) {
    // trust proxy 已按 TRUST_PROXY 解析过 X-Forwarded-For：
    // req.ip 取的是"最右侧不可信地址"，客户端伪造的 XFF 影响不到它。
    let clientIp = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

    // 处理IPv4映射的IPv6地址
    if (clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
    }

    // 只有对端仍是本机回环（没能解析出真实客户端）时，才退回代理头
    if (!clientIp || clientIp === '::1' || clientIp === '127.0.0.1') {
        const forwarded = req.headers['x-real-ip'] ||
            // x-forwarded-for 取最右侧（代理最后写入的）地址，
            // 最左侧是客户端可伪造的，只能作为最后手段
            (req.headers['x-forwarded-for'] || '').split(',').pop() ||
            (req.socket && req.socket.remoteAddress) ||
            'unknown';

        clientIp = String(forwarded).trim();

        // 再次处理IPv4映射的IPv6地址
        if (clientIp.startsWith('::ffff:')) {
            clientIp = clientIp.substring(7);
        }
    }

    return clientIp || 'unknown';
}

// 操作日志中间件
async function logOperation(req, res, next) {
    const clientIp = getClientIp(req);
    const operationDesc = req.headers['x-operation-desc']
        ? decodeURIComponent(req.headers['x-operation-desc'])
        : `${req.method} ${req.path}`;

    const logEntry = {
        timestamp: new Date().toISOString(),
        ip: clientIp,
        operation: operationDesc,
        method: req.method,
        path: req.path,
        userAgent: req.headers['user-agent']
    };

    // 记录操作日志
    const logs = await readOperationLog();
    logs.push(logEntry);

    // 只保留最近 keepDays 天的记录（天数来自 config.js 的 operationLogKeepDays）
    const keepDays = asPositiveInt(FILE_CONFIG.operationLogKeepDays, 30);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const recentLogs = logs.filter(log => {
        return new Date(log.timestamp) > cutoff;
    });

    await writeOperationLog(recentLogs);

    // 传递操作描述到后续处理
    res.locals.operationDesc = operationDesc;

    next();
}

// ==================== 每日上传额度（服务端是唯一计数来源） ====================
// 规则：每个 IP 每个自然日最多成功上传 UPLOAD_DAILY_LIMIT 次。
//
// 为什么改：以前服务端按"本 IP + 滚动 24 小时 + 所有写请求"计数，
// 前端却按"本浏览器 + 自然日 + 只有成功的请求"计数（localStorage），
// 两边必然对不上 —— 于是出现"页面显示还剩 6 次，上传却提示频率超限"。
// 现在额度只由服务端统计，前端通过 GET /api/upload-quota 和响应头展示真实剩余次数。
//
// 另外：只有"真正成功的上传"才计入额度。校验失败（格式/大小/名称）、404、500
// 会退还预留的额度，不再出现"传错一次就白白扣掉一次"的情况。
const QUOTA_KEEP_DAYS = asPositiveInt(FILE_CONFIG.quotaKeepDays, 7);

/** 解析每日上传额度：默认 8；0/off/unlimited/负数 = 不限量（本地测试用） */
function parseDailyLimit(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return 8;
    const value = String(raw).trim().toLowerCase();
    if (['0', 'off', 'false', 'no', 'unlimited', 'none'].includes(value)) return 0;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        console.warn(`[quota] uploadDailyLimit/UPLOAD_DAILY_LIMIT="${raw}" 不是合法数字，回退为 8`);
        return 8;
    }
    return parsed;
}

const UPLOAD_DAILY_LIMIT_SETTING = pick('UPLOAD_DAILY_LIMIT', FILE_CONFIG.uploadDailyLimit, 8);
const UPLOAD_DAILY_LIMIT = parseDailyLimit(UPLOAD_DAILY_LIMIT_SETTING.value);
const UPLOAD_UNLIMITED = UPLOAD_DAILY_LIMIT <= 0;

/** 自然日 key（服务器本地时区），如 2026-09-15 */
function dayKeyOf(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 额度重置时间 = 次日 00:00（服务器本地时区） */
function nextResetTime(now) {
    const next = new Date(now || Date.now());
    next.setHours(24, 0, 0, 0);
    return next;
}

function formatResetTime(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 内存缓存 + 串行队列：避免每个请求都读文件，也避免并发请求"读-改-写"互相覆盖。
// 额度、点赞、抽卡次数三个状态文件共用这一把锁（都是小 JSON，串行化最简单也最安全）。
let quotaRecords = null;
let stateChain = Promise.resolve();

function withStateLock(task) {
    const run = stateChain.then(task, task);
    stateChain = run.then(() => { }, () => { });
    return run;
}

/** 只保留最近 QUOTA_KEEP_DAYS 天、且字段完整的记录；旧格式记录视为无效直接丢弃 */
function normalizeQuotaRecords(raw) {
    if (!Array.isArray(raw)) return [];
    const today = dayKeyOf();
    const oldest = dayKeyOf(new Date(Date.now() - QUOTA_KEEP_DAYS * 24 * 60 * 60 * 1000));
    return raw.filter(r =>
        r && typeof r === 'object' &&
        typeof r.ip === 'string' && r.ip &&
        typeof r.day === 'string' && r.day >= oldest && r.day <= today &&
        (r.status === 'ok' || r.status === 'pending')
    );
}

async function loadQuotaRecords() {
    if (quotaRecords) return quotaRecords;
    let raw = [];
    try {
        raw = await readJsonFile(ipOperationsPath);
    } catch (error) {
        raw = []; // 文件不存在/损坏时从空开始，不影响上传
    }
    // 说明：改造前写下的记录没有 day/status 字段（滚动 24h 的旧逻辑，
    // 且统计了失败的请求），这里会被丢弃 —— 修复后当天额度从干净状态重新计算。
    quotaRecords = normalizeQuotaRecords(raw);
    return quotaRecords;
}

async function persistQuotaRecords() {
    try {
        await fs.writeFile(ipOperationsPath, JSON.stringify(quotaRecords));
    } catch (error) {
        console.error('Error writing ip operations:', error);
    }
}

/** 某 IP 当前额度快照 */
function quotaSnapshotOf(records, ip, now) {
    const date = now || new Date();
    const day = dayKeyOf(date);
    const used = records.filter(r => r.ip === ip && r.day === day).length;
    const resetAt = nextResetTime(date).toISOString();

    if (UPLOAD_UNLIMITED) {
        return { unlimited: true, limit: null, used, remaining: null, day, resetAt };
    }
    return {
        unlimited: false,
        limit: UPLOAD_DAILY_LIMIT,
        used,
        remaining: Math.max(0, UPLOAD_DAILY_LIMIT - used),
        day,
        resetAt
    };
}

async function getQuotaSnapshot(ip) {
    return await withStateLock(async () => {
        const records = await loadQuotaRecords();
        const pruned = normalizeQuotaRecords(records);
        if (pruned.length !== records.length) {
            quotaRecords = pruned;
            await persistQuotaRecords();
        }
        return quotaSnapshotOf(quotaRecords, ip);
    });
}

/**
 * 预留一次额度（pending 也计入已用，保证并发请求挤不过额度）。
 * 返回 { allowed, id, snapshot }；超限时 allowed=false 且不写记录。
 */
async function reserveQuota(ip, req) {
    return await withStateLock(async () => {
        const records = await loadQuotaRecords();
        const pruned = normalizeQuotaRecords(records);
        if (pruned.length !== records.length) quotaRecords = pruned;

        const snapshot = quotaSnapshotOf(quotaRecords, ip);
        if (!snapshot.unlimited && snapshot.remaining <= 0) {
            if (pruned.length !== records.length) await persistQuotaRecords();
            return { allowed: false, id: null, snapshot };
        }

        const record = {
            id: uuidv4(),
            ip: ip,
            day: snapshot.day,
            status: 'pending',
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path
        };
        quotaRecords.push(record);

        return { allowed: true, id: record.id, snapshot: quotaSnapshotOf(quotaRecords, ip) };
    });
}

/** 结算预留：成功 -> 记为 ok；失败/中断 -> 删除记录，把额度退还给用户 */
async function settleQuota(id, ok) {
    if (!id) return;
    await withStateLock(async () => {
        const records = await loadQuotaRecords();
        const record = records.find(r => r.id === id);
        if (!record) return;

        if (ok) {
            record.status = 'ok';
            quotaRecords = records;
        } else {
            quotaRecords = records.filter(r => r.id !== id);
        }
        await persistQuotaRecords();
    });
}

function applyQuotaHeaders(res, snapshot) {
    if (!snapshot) return;
    if (snapshot.unlimited) {
        res.setHeader('X-RateLimit-Limit', 'unlimited');
        res.setHeader('X-RateLimit-Remaining', 'unlimited');
        return;
    }
    res.setHeader('X-RateLimit-Limit', String(snapshot.limit));
    res.setHeader('X-RateLimit-Remaining', String(snapshot.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(new Date(snapshot.resetAt).getTime() / 1000)));
}

/** 哪些请求算"一次上传"：新增；以及带了新图片的编辑。删除、仅改名不占额度 */
function countsAsUpload(req) {
    if (req.method === 'POST') return true;
    if (req.method === 'PUT') return Boolean(req.file);
    return false;
}

/**
 * 上传失败兜底：任何非 2xx 响应都清掉 multer 已经落盘的文件，避免留下孤儿图片。
 * 之前 POST 在"名称为空/超长"这类校验里直接 return 400，没有删文件，
 * 图片就会一直留在 public/images 里（只计额度不占位、没人引用）。
 */
function discardUploadOnError(req, res, next) {
    res.on('finish', () => {
        if (res.statusCode < 400) return;
        if (!req.file || !req.file.path) return;
        fs.unlink(req.file.path).catch(() => { /* 已删除或文件不存在，忽略 */ });
    });
    next();
}

/**
 * 上传额度中间件（必须排在 multer 之后：要按 req.file 判断是否带新图，
 * 且被拒时文件已落盘，需要清掉避免留下孤儿图片）。
 */
async function uploadQuotaGuard(req, res, next) {
    const clientIp = getClientIp(req);

    let reserved;
    try {
        if (countsAsUpload(req)) {
            reserved = await reserveQuota(clientIp, req);
        } else {
            reserved = { allowed: true, id: null, snapshot: await getQuotaSnapshot(clientIp) };
        }
    } catch (error) {
        // 额度统计出问题不应该挡住正常上传
        console.error('Error checking upload quota:', error);
        return next();
    }

    if (!reserved.allowed) {
        console.log(`Upload quota exceeded for IP: ${clientIp} (${reserved.snapshot.used}/${reserved.snapshot.limit})`);

        if (req.file && req.file.path) {
            try { await fs.unlink(req.file.path); } catch (e) { /* ignore */ }
            req.file = undefined;
        }

        const waitSeconds = Math.max(1, Math.ceil((new Date(reserved.snapshot.resetAt).getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(waitSeconds));
        applyQuotaHeaders(res, { ...reserved.snapshot, remaining: 0 });

        return res.status(429).json({
            error: '操作频率超限',
            message: `单个IP每天最多上传 ${reserved.snapshot.limit} 次，今日额度已用完`
                + `（已用 ${reserved.snapshot.used} 次），将于 ${formatResetTime(reserved.snapshot.resetAt)} 重置`,
            limit: reserved.snapshot.limit,
            used: reserved.snapshot.used,
            remaining: 0,
            resetAt: reserved.snapshot.resetAt,
            retryAfter: waitSeconds
        });
    }

    // 只有 2xx 才真正消耗额度；失败或客户端中断会自动退还
    let settled = false;
    const settle = (ok) => {
        if (settled) return;
        settled = true;
        settleQuota(reserved.id, ok).catch(error => console.error('Error settling upload quota:', error));
    };
    res.on('finish', () => settle(res.statusCode < 400));
    res.on('close', () => settle(Boolean(res.writableFinished) && res.statusCode < 400));

    applyQuotaHeaders(res, reserved.snapshot);
    next();
}

// 初始化操作文件
initOperationFiles();

// ==================== 点赞 ====================
// 结构：{ "<birdId>": ["<ip>", ...] }，点赞数 = 数组长度。
// 同一 IP 对同一张图只能赞一次（再点就是取消）——否则任何人刷新几下就能把抽卡概率刷歪。
let likesCache = null;

async function loadLikes() {
    if (likesCache) return likesCache;
    likesCache = {};
    try {
        const raw = await readJsonFile(likesPath);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [id, ips] of Object.entries(raw)) {
                if (Array.isArray(ips)) {
                    likesCache[id] = [...new Set(ips.filter(ip => typeof ip === 'string' && ip))];
                }
            }
        }
    } catch (error) {
        likesCache = {};   // 文件不存在/损坏时从空开始
    }
    return likesCache;
}

async function persistLikes() {
    try {
        await fs.writeFile(likesPath, JSON.stringify(likesCache));
    } catch (error) {
        console.error('Error writing likes:', error);
    }
}

function likeCountOf(likes, birdId) {
    const ips = likes[String(birdId)];
    return ips ? ips.length : 0;
}

function isLikedBy(likes, birdId, ip) {
    const ips = likes[String(birdId)];
    return Boolean(ips && ips.includes(ip));
}

async function toggleLike(ip, birdId) {
    return await withStateLock(async () => {
        const likes = await loadLikes();
        const key = String(birdId);
        const ips = likes[key] || (likes[key] = []);
        const index = ips.indexOf(ip);
        let liked;
        if (index >= 0) {
            ips.splice(index, 1);
            liked = false;
        } else {
            ips.push(ip);
            liked = true;
        }
        if (!ips.length) delete likes[key];
        await persistLikes();
        return { likes: ips.length, liked };
    });
}

// ==================== 抽卡：稀有度与奖池 ====================
// 档位全部来自 config.js 的 gacha.tiers（默认：传说 5% / 史诗 15% / 稀有 30% / 普通 50%）。
// 归属规则：按点赞数排名，从上到下按 share 切档（默认 2% / 8% / 30% / 60%）。
// 稀有档人数少 => 单张传说远比单张普通难抽（约 1.25% vs 0.43%），即"点赞越多越稀有"。
const GACHA_SETTING = (FILE_CONFIG.gacha && typeof FILE_CONFIG.gacha === 'object') ? FILE_CONFIG.gacha : {};

/** 归一化配置里的档位：补默认值、rate/share 各自归一到 1、丢掉非法项 */
function normalizeTierConfig(rawTiers) {
    const fallback = [
        { key: 'legendary', label: '传说', rate: 0.05, share: 0.02 },
        { key: 'epic', label: '史诗', rate: 0.15, share: 0.08 },
        { key: 'rare', label: '稀有', rate: 0.30, share: 0.30 },
        { key: 'common', label: '普通', rate: 0.50, share: 0.60 }
    ];
    const input = Array.isArray(rawTiers) && rawTiers.length ? rawTiers : fallback;

    const cleaned = [];
    input.forEach((tier, index) => {
        if (!tier || typeof tier !== 'object') return;
        const rate = Number(tier.rate);
        const share = Number(tier.share);
        if (!(rate > 0) || !(share > 0)) {
            console.warn(`[gacha] 档位 ${index} 的 rate/share 必须为正数，已忽略：${JSON.stringify(tier)}`);
            return;
        }
        cleaned.push({
            key: typeof tier.key === 'string' && tier.key ? tier.key : `tier${index + 1}`,
            label: typeof tier.label === 'string' && tier.label ? tier.label : `档位${index + 1}`,
            rate,
            share
        });
    });
    if (!cleaned.length) return normalizeTierConfig(fallback);

    // 各自归一，避免手改配置后概率总和不是 1（否则抽卡会静默偏移）
    const rateSum = cleaned.reduce((sum, tier) => sum + tier.rate, 0);
    const shareSum = cleaned.reduce((sum, tier) => sum + tier.share, 0);
    if (Math.abs(rateSum - 1) > 1e-6) {
        console.warn(`[gacha] 档位概率合计为 ${rateSum.toFixed(3)}，已自动归一到 1`);
    }
    if (Math.abs(shareSum - 1) > 1e-6) {
        console.warn(`[gacha] 档位占比合计为 ${shareSum.toFixed(3)}，已自动归一到 1`);
    }
    return cleaned.map(tier => ({
        ...tier,
        rate: tier.rate / rateSum,
        share: tier.share / shareSum
    }));
}

const RARITY_TIERS = normalizeTierConfig(GACHA_SETTING.tiers);
const TIER_BY_KEY = new Map(RARITY_TIERS.map(tier => [tier.key, tier]));
const DEFAULT_TIER = TIER_BY_KEY.get('common') || RARITY_TIERS[RARITY_TIERS.length - 1];

/** 按点赞排名切档；返回 { pool, tierOf }（tierOf: birdId -> 档位） */
function buildGachaPool(likes) {
    const ranked = birds
        .map(bird => ({ bird, likes: likeCountOf(likes, bird.id) }))
        .sort((a, b) => b.likes - a.likes || a.bird.id - b.bird.id);

    const pool = {};
    const tierOf = new Map();
    const total = ranked.length;
    let cursor = 0;

    RARITY_TIERS.forEach((tier, index) => {
        const end = index === RARITY_TIERS.length - 1
            ? total
            : Math.min(total, cursor + Math.round(tier.share * total));
        pool[tier.key] = ranked.slice(cursor, end);
        for (const entry of pool[tier.key]) tierOf.set(entry.bird.id, tier);
        cursor = end;
    });

    return { pool, tierOf };
}

/** 抽 count 次；同一批内不重复（池子足够大，重复只会让 zip 里出现同名文件） */
function drawGacha(pool, count) {
    const lists = {};
    for (const key of Object.keys(pool)) lists[key] = pool[key].slice();

    const picks = [];
    for (let i = 0; i < count; i++) {
        const available = RARITY_TIERS
            .map(tier => ({ tier, list: lists[tier.key] }))
            .filter(item => item.list.length);
        if (!available.length) break;

        // 某个档位为空时，它的概率按剩余档位重新归一分摊
        // （正常情况下四个档位都非空，就是 5/15/30/50）
        const totalRate = available.reduce((sum, item) => sum + item.tier.rate, 0);
        let roll = Math.random() * totalRate;
        let chosen = available[available.length - 1];
        for (const item of available) {
            roll -= item.tier.rate;
            if (roll < 0) { chosen = item; break; }
        }

        const [entry] = chosen.list.splice(Math.floor(Math.random() * chosen.list.length), 1);
        picks.push({
            id: entry.bird.id,
            name: entry.bird.name,
            imageUrl: entry.bird.imageUrl,
            likes: entry.likes,
            tierKey: chosen.tier.key,
            tierLabel: chosen.tier.label,
            rate: chosen.tier.rate
        });
    }
    return picks;
}

function gachaPoolSummary(pool) {
    return {
        total: birds.length,
        rates: RARITY_TIERS.map(tier => ({
            key: tier.key,
            label: tier.label,
            rate: tier.rate,
            count: pool[tier.key].length
        }))
    };
}

// ==================== 抽卡次数（券） ====================
// 每个 IP 一份：每日首次访问送 2 张单抽券 + 1 张十连券（没用完的留着，不清零），
// 每成功上传 1 张图片再奖励 1 张单抽券。次数存服务端 —— 刷新页面、清缓存都刷不出来。
const DAILY_SINGLE_TICKETS = asInt(GACHA_SETTING.dailySingleTickets, 2);
const DAILY_TEN_TICKETS = asInt(GACHA_SETTING.dailyTenTickets, 1);
const TEN_PULL_SINGLE_COST = asPositiveInt(GACHA_SETTING.tenPullSingleCost, 10);
const GACHA_ZIP_MAX_IMAGES = asPositiveInt(GACHA_SETTING.zipMaxImages, 10);
let ticketsCache = null;

async function loadTickets() {
    if (ticketsCache) return ticketsCache;
    try {
        const raw = await readJsonFile(gachaTicketsPath);
        ticketsCache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch (error) {
        ticketsCache = {};
    }
    return ticketsCache;
}

async function persistTickets() {
    try {
        await fs.writeFile(gachaTicketsPath, JSON.stringify(ticketsCache));
    } catch (error) {
        console.error('Error writing gacha tickets:', error);
    }
}

/** 取（必要时创建）某 IP 的券状态；当天第一次访问时发放每日额度 */
function ticketStateOf(tickets, ip, day) {
    const state = tickets[ip] || (tickets[ip] = { day: '', single: 0, ten: 0, uploads: 0 });
    let granted = null;
    if (state.day !== day) {
        state.day = day;
        state.single = Math.max(0, state.single | 0) + DAILY_SINGLE_TICKETS;
        state.ten = Math.max(0, state.ten | 0) + DAILY_TEN_TICKETS;
        granted = { single: DAILY_SINGLE_TICKETS, ten: DAILY_TEN_TICKETS };
    }
    return { state, granted };
}

function ticketSnapshot(state) {
    return {
        single: Math.max(0, state.single | 0),
        ten: Math.max(0, state.ten | 0),
        uploads: Math.max(0, state.uploads | 0)
    };
}

/** GET /api/gacha/tickets 会顺带完成"每日登录"发放 */
async function readGachaState(ip) {
    return await withStateLock(async () => {
        const tickets = await loadTickets();
        const { state, granted } = ticketStateOf(tickets, ip, dayKeyOf());
        if (granted) await persistTickets();

        const likes = await loadLikes();
        const { pool } = buildGachaPool(likes);
        return {
            tickets: ticketSnapshot(state),
            grantedToday: granted,
            daily: { single: DAILY_SINGLE_TICKETS, ten: DAILY_TEN_TICKETS },
            pool: gachaPoolSummary(pool)
        };
    });
}

/** 上传成功奖励 1 张单抽券 */
async function grantUploadTicket(ip) {
    return await withStateLock(async () => {
        const tickets = await loadTickets();
        const { state } = ticketStateOf(tickets, ip, dayKeyOf());
        state.single = (state.single | 0) + 1;
        state.uploads = (state.uploads | 0) + 1;
        await persistTickets();
        return ticketSnapshot(state);
    });
}

/** 扣券 + 抽卡（同一把锁内完成，避免并发把券扣成负数） */
async function pullGacha(ip, count) {
    return await withStateLock(async () => {
        const tickets = await loadTickets();
        const { state, granted } = ticketStateOf(tickets, ip, dayKeyOf());
        if (granted) await persistTickets();

        if (count === 10) {
            if ((state.ten | 0) >= 1) {
                state.ten = (state.ten | 0) - 1;
            } else if ((state.single | 0) >= TEN_PULL_SINGLE_COST) {
                state.single = (state.single | 0) - TEN_PULL_SINGLE_COST;   // 没有十连券时允许用单抽券抵
            } else {
                return {
                    ok: false,
                    message: `十连抽需要 1 张十连券（或用 ${TEN_PULL_SINGLE_COST} 张单抽券）`,
                    tickets: ticketSnapshot(state)
                };
            }
        } else {
            if ((state.single | 0) < 1) {
                return {
                    ok: false,
                    message: '没有抽卡次数了：每日登录送 2 次单抽 + 1 次十连，每上传 1 张图片再送 1 次单抽',
                    tickets: ticketSnapshot(state)
                };
            }
            state.single = (state.single | 0) - 1;
        }
        await persistTickets();

        const likes = await loadLikes();
        const { pool } = buildGachaPool(likes);
        return {
            ok: true,
            results: drawGacha(pool, count),
            tickets: ticketSnapshot(state),
            pool: gachaPoolSummary(pool)
        };
    });
}

// ==================== 管理员登录（编辑 / 删除 的鉴权） ====================
// 目标：上公网后不能靠"搜索框输入暗号"来获得管理权限 —— 任何人都能试出来，
// 而且口令会出现在 URL 与访问日志里。现在改成：
//   1. 口令只在 POST /api/admin/login 的请求体里提交一次，服务端只保存它的 SHA-256；
//   2. 校验通过后发一个 HMAC 签名的会话 token（默认 12 小时），前端存在 localStorage；
//   3. 编辑（PUT）与删除（DELETE）必须带 X-Admin-Token，否则 401；
//      上传（POST）保持公开 —— 这是站点本身的功能，不需要管理权限。
// 只存哈希 + 定长常数时间比较，避免口令明文落盘与比较时的时序侧信道。
const ADMIN_SESSION_HOURS_SETTING = pick('ADMIN_SESSION_HOURS', FILE_CONFIG.adminSessionHours, 12);
const ADMIN_SESSION_HOURS = asPositiveInt(ADMIN_SESSION_HOURS_SETTING.value, 12);
const DEFAULT_ADMIN_KEY = 'yelu666';
const ADMIN_KEY_SETTING = pick('ADMIN_KEY', FILE_CONFIG.adminKey, '');
const ADMIN_KEY_HASH_SETTING = pick('ADMIN_KEY_HASH', FILE_CONFIG.adminKeyHash, '');
const ADMIN_KEY = asString(ADMIN_KEY_SETTING.value, '');
const ADMIN_KEY_HASH = asString(ADMIN_KEY_HASH_SETTING.value, '').toLowerCase();
const hasCustomAdminKey = /^[0-9a-f]{64}$/.test(ADMIN_KEY_HASH) || ADMIN_KEY !== '';

function sha256Hex(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// 生效的口令哈希：优先 ADMIN_KEY_HASH（推荐），其次 ADMIN_KEY，最后回退默认口令
const activeAdminKeyHash = /^[0-9a-f]{64}$/.test(ADMIN_KEY_HASH)
    ? ADMIN_KEY_HASH
    : sha256Hex(ADMIN_KEY || DEFAULT_ADMIN_KEY);

// 会话密钥由口令哈希派生：重启服务后 token 依然有效，也不需要额外存密钥文件；
// 换了口令 => 老 token 全部失效（这正是想要的行为）。
const ADMIN_SESSION_SECRET = crypto.createHash('sha256')
    .update(`yelu-admin-session:${activeAdminKeyHash}`)
    .digest();

function createAdminToken() {
    const payload = Buffer.from(JSON.stringify({
        exp: Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000
    }), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function verifyAdminToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;

    const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    const given = Buffer.from(signature, 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return false;

    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return Number.isFinite(data.exp) && data.exp > Date.now();
    } catch (error) {
        return false;
    }
}

function adminTokenOf(req) {
    const header = req.headers['x-admin-token'];
    return typeof header === 'string' ? header.trim() : '';
}

function isAdminRequest(req) {
    return verifyAdminToken(adminTokenOf(req));
}

/** 口令比对：两边都是定长哈希，比较用 timingSafeEqual */
function checkAdminKey(key) {
    const given = Buffer.from(sha256Hex(key), 'hex');
    const expected = Buffer.from(activeAdminKeyHash, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** 编辑 / 删除 必须登录；未登录直接拒绝，连文件都不收（所以排在 multer 之前） */
function requireAdmin(req, res, next) {
    if (isAdminRequest(req)) return next();
    return res.status(401).json({ error: '需要管理员登录后才能编辑或删除' });
}

// 登录接口单独限流，避免有人拿字典慢慢试口令
const ADMIN_LOGIN_WINDOW_MINUTES = asPositiveInt(FILE_CONFIG.adminLoginWindowMinutes, 5);
const ADMIN_LOGIN_ATTEMPTS = asPositiveInt(FILE_CONFIG.adminLoginAttempts, 8);
const adminLoginLimiter = rateLimit({
    windowMs: ADMIN_LOGIN_WINDOW_MINUTES * 60 * 1000,
    max: ADMIN_LOGIN_ATTEMPTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: `尝试过于频繁，请 ${ADMIN_LOGIN_WINDOW_MINUTES} 分钟后再试` }
});

// ==================== 打包下载（zip） ====================
// 只打包"本批抽到的图"。自己写 ZIP（store 方式，不压缩）：JPEG/WebP 本来就压过了，
// 再 deflate 只会白烧 CPU；store 方式只需要 CRC32 + 头结构，不引入任何新依赖。
// 逐张流式写：先读完一遍算 CRC32 与大小，再写本地头 + 原样输出文件内容，内存占用与图片大小无关。
const ZIP_UTF8_FLAG = 0x0800;   // 文件名按 UTF-8 编码（中文名在资源管理器里才不会乱码）
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    return table;
})();

function crc32Update(state, chunk) {
    let c = state;
    for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xFF] ^ (c >>> 8);
    return c;
}

/** 流式读一遍文件，得到 { crc, size }（不把文件读进内存） */
async function scanFileForZip(absPath) {
    return await new Promise((resolve, reject) => {
        let state = -1;   // 0xFFFFFFFF
        let size = 0;
        const stream = fsSync.createReadStream(absPath);
        stream.on('data', chunk => {
            state = crc32Update(state, chunk);
            size += chunk.length;
        });
        stream.on('end', () => resolve({ crc: (state ^ -1) >>> 0, size }));
        stream.on('error', reject);
    });
}

function zipLocalHeader(nameBuf, crc, size) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);            // 解压所需版本
    header.writeUInt16LE(ZIP_UTF8_FLAG, 6); // 通用标志位
    header.writeUInt16LE(0, 8);             // 压缩方式 0 = store
    header.writeUInt16LE(0, 10);            // 修改时间
    header.writeUInt16LE(0x21, 12);         // 修改日期（1980-01-01）
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);         // 压缩后大小
    header.writeUInt32LE(size, 22);         // 原始大小
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);            // 扩展字段长度
    return Buffer.concat([header, nameBuf]);
}

function zipCentralHeader(nameBuf, crc, size, offset) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);            // 创建版本
    header.writeUInt16LE(20, 6);            // 解压所需版本
    header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    header.writeUInt16LE(0, 10);            // 压缩方式
    header.writeUInt16LE(0, 12);            // 时间
    header.writeUInt16LE(0x21, 14);         // 日期
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(0, 38);            // 外部属性
    header.writeUInt32LE(offset, 42);       // 本地头偏移
    return Buffer.concat([header, nameBuf]);
}

function zipEndRecord(entryCount, centralSize, centralOffset) {
    const record = Buffer.alloc(22);
    record.writeUInt32LE(0x06054b50, 0);
    record.writeUInt16LE(entryCount, 8);
    record.writeUInt16LE(entryCount, 10);
    record.writeUInt32LE(centralSize, 12);
    record.writeUInt32LE(centralOffset, 16);
    return record;
}

async function writeZipStream(res, entries) {
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const { crc, size } = await scanFileForZip(entry.absPath);
        const nameBuf = Buffer.from(entry.name, 'utf8');

        const local = zipLocalHeader(nameBuf, crc, size);
        if (!res.write(local)) await once(res, 'drain');
        central.push({ nameBuf, crc, size, offset });
        offset += local.length;

        // 原样把所有字节送出去（边读边写，不整张读进内存；写不动就暂停读流）
        await new Promise((resolve, reject) => {
            const stream = fsSync.createReadStream(entry.absPath);
            const onDrain = () => stream.resume();
            stream.on('data', chunk => {
                if (!res.write(chunk)) stream.pause();
            });
            res.on('drain', onDrain);
            stream.on('end', () => { res.off('drain', onDrain); resolve(); });
            stream.on('error', error => { res.off('drain', onDrain); reject(error); });
        });
        offset += size;
    }

    const centralStart = offset;
    for (const item of central) {
        const header = zipCentralHeader(item.nameBuf, item.crc, item.size, item.offset);
        if (!res.write(header)) await once(res, 'drain');
    }
    const centralSize = central.reduce((sum, item) => sum + 46 + item.nameBuf.length, 0);
    res.write(zipEndRecord(central.length, centralSize, centralStart));
}

/** 文件名里不能出现路径分隔符，且同一批内不能重名 */
function sanitizeZipName(name, ext, used) {
    let base = String(name || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || '未命名';
    let candidate = `${base}${ext}`;
    let i = 2;
    while (used.has(candidate)) candidate = `${base}(${i++})${ext}`;
    used.add(candidate);
    return candidate;
}


// 夜鹭检测的频率限制
// 注意：绝不能复用 uploadQuotaGuard（会写 ip_operations.json 并占用每日上传额度），
// 否则用户点两次检测就会吃掉当天的上传额度。检测是只读操作，单独限流。
const detectLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: asPositiveInt(FILE_CONFIG.detectPerMinute, 20), // 次/分钟/IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '检测请求过于频繁，请稍后再试' }
});

// 写操作的轻量防刷限流：删除、仅改名不占每日上传额度，改由这里兜底，
// 同时挡住"反复提交非法图片"这类不消耗额度但会吃 CPU 的请求。
const writeBurstLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: asPositiveInt(FILE_CONFIG.writeBurstPerMinute, 30), // 次/分钟/IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '操作过于频繁，请稍后再试' }
});

// 模拟鸟类数据
let birds = [];
const DATA_FILE = path.join(__dirname, 'data.json');

// 初始化数据
async function initData() {
    try {
        birds = await readJsonFile(DATA_FILE);
    } catch (error) {
        // 如果文件不存在或有错误，使用空数组
        birds = [];
    }
}

// 保存数据
async function saveData() {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(birds, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// 根路径路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 查询当前 IP 的今日上传额度 —— 前端展示"今日还可上传 x/y 次"的唯一来源。
// 必须 no-store：全局 /api 缓存中间件默认会把这个响应缓存 1 小时，那样剩余次数就永远是旧的。
app.get('/api/upload-quota', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const snapshot = await getQuotaSnapshot(getClientIp(req));
        applyQuotaHeaders(res, snapshot);
        res.json(snapshot);
    } catch (error) {
        console.error('Error reading upload quota:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 前端要用的展示型配置（不含任何密钥）。改名/调参后前端文案与校验自动跟着变。
app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        maxImageMB: MAX_IMAGE_MB,
        uploadDailyLimit: UPLOAD_UNLIMITED ? 0 : UPLOAD_DAILY_LIMIT,
        gacha: {
            dailySingleTickets: DAILY_SINGLE_TICKETS,
            dailyTenTickets: DAILY_TEN_TICKETS,
            tenPullSingleCost: TEN_PULL_SINGLE_COST,
            zipMaxImages: GACHA_ZIP_MAX_IMAGES,
            tiers: RARITY_TIERS.map(tier => ({
                key: tier.key,
                label: tier.label,
                rate: tier.rate,
                share: tier.share
            }))
        }
    });
});

// 管理员登录：口令只在这里出现一次，成功后拿到会话 token
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = (req.body && typeof req.body.key === 'string') ? req.body.key : '';
    if (!key) {
        return res.status(400).json({ error: '请输入口令' });
    }
    if (!checkAdminKey(key)) {
        console.warn(`[admin] 口令错误（IP: ${getClientIp(req)}）`);
        return res.status(401).json({ error: '口令不正确' });
    }
    res.json({ token: createAdminToken(), expiresInHours: ADMIN_SESSION_HOURS });
});

// 校验当前 token 是否还有效（前端刷新页面后用它确认是否仍是管理员）
app.get('/api/admin/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ admin: isAdminRequest(req) });
});

// 获取鸟类列表（附带点赞数、稀有度、本人是否已赞）
app.get('/api/birds', async (req, res) => {    try {
        const page = parseInt(req.query.page) || 1;
        const search = req.query.search || '';
        const pageSize = 48;

        // 管理员身份只认 token，不再认"搜索框里输暗号"
        const isAdmin = isAdminRequest(req);

        let filteredBirds = birds;

        if (search) {
            filteredBirds = birds.filter(bird =>
                bird.name.toLowerCase().includes(search.toLowerCase())
            );
        }

        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;

        const clientIp = getClientIp(req);
        const likes = await loadLikes();
        const { tierOf } = buildGachaPool(likes);

        const paginatedBirds = filteredBirds.slice(startIndex, endIndex).map(bird => {
            const tier = tierOf.get(bird.id) || DEFAULT_TIER;
            return {
                ...bird,
                likes: likeCountOf(likes, bird.id),
                liked: isLikedBy(likes, bird.id, clientIp),
                tier: tier.label,
                tierKey: tier.key,
                tierRate: tier.rate
            };
        });

        const hasMore = endIndex < filteredBirds.length;

        res.json({
            birds: paginatedBirds,
            hasMore: hasMore,
            isAdmin: isAdmin
        });
    } catch (error) {
        console.error('Error fetching birds:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 点赞 / 取消点赞（同一 IP 对同一张图只算一次）
app.post('/api/birds/:id/like', writeBurstLimiter, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id) || !birds.some(bird => bird.id === id)) {
            return res.status(404).json({ error: 'Bird not found' });
        }
        const result = await toggleLike(getClientIp(req), id);
        res.set('Cache-Control', 'no-store');
        res.json({ id, likes: result.likes, liked: result.liked });
    } catch (error) {
        console.error('Error toggling like:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 抽卡状态：券的数量 + 每日赠送 + 奖池概率（这个 GET 顺带完成"每日登录"发放）
app.get('/api/gacha/tickets', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        res.json(await readGachaState(getClientIp(req)));
    } catch (error) {
        console.error('Error reading gacha state:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 只看奖池与概率
app.get('/api/gacha/pool', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const likes = await loadLikes();
        const { pool } = buildGachaPool(likes);
        res.json(gachaPoolSummary(pool));
    } catch (error) {
        console.error('Error reading gacha pool:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 抽卡：count 只接受 1（单抽）或 10（十连）
app.post('/api/gacha/pull', writeBurstLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        if (!birds.length) {
            return res.status(409).json({ error: '奖池里还没有图片，先上传几张吧' });
        }
        const count = Number(req.body && req.body.count) === 10 ? 10 : 1;
        const result = await pullGacha(getClientIp(req), count);
        if (!result.ok) {
            return res.status(403).json({ error: result.message, tickets: result.tickets });
        }
        res.json(result);
    } catch (error) {
        console.error('Error pulling gacha:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 打包本批抽到的图（zip，store 方式流式输出，不占内存）
app.post('/api/gacha/zip', writeBurstLimiter, async (req, res) => {
    try {
        const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
        const ids = [...new Set(rawIds.map(value => parseInt(value, 10)).filter(Number.isInteger))];
        if (!ids.length) {
            return res.status(400).json({ error: '缺少要打包的图片' });
        }
        if (ids.length > GACHA_ZIP_MAX_IMAGES) {
            return res.status(400).json({ error: `一次最多打包 ${GACHA_ZIP_MAX_IMAGES} 张（一个十连的量）` });
        }

        const likes = await loadLikes();
        const { tierOf } = buildGachaPool(likes);
        const used = new Set();
        const entries = [];

        for (const id of ids) {
            const bird = birds.find(item => item.id === id);
            if (!bird || !bird.imageUrl) continue;

            // 只允许打包 public/images 下的文件，防目录穿越
            const absPath = path.join(__dirname, 'public', 'images', path.basename(bird.imageUrl));
            try {
                await fs.access(absPath);
            } catch (error) {
                continue;
            }

            const tier = tierOf.get(bird.id) || DEFAULT_TIER;
            const ext = path.extname(absPath).toLowerCase() || '.jpg';
            entries.push({
                absPath,
                name: sanitizeZipName(`${tier.label}_${bird.name}`, ext, used)
            });
        }

        if (!entries.length) {
            return res.status(404).json({ error: '没有找到可打包的图片' });
        }

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="yelu-gacha-${stamp}.zip"`);
        res.setHeader('Cache-Control', 'no-store');
        await writeZipStream(res, entries);
        res.end();
    } catch (error) {
        console.error('Error building gacha zip:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        } else {
            res.destroy();
        }
    }
});

// 获取鸟类总数和种类数
app.get('/api/birds/count', async (req, res) => {
    try {
        // 设置响应头，禁止缓存
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        // 计算不重复的鸟类名称数量
        const uniqueBirdNames = new Set(birds.map(bird => bird.name));

        res.json({
            count: birds.length,
            type: uniqueBirdNames.size
        });
    } catch (error) {
        console.error('Error fetching bird count:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ 夜鹭检测（上传阶段筛选） ============
// 设计原则：闸门只做提示，永不阻塞上传。
// - 检出夜鹭  -> pass=true，直接通过
// - 未检出    -> pass=false，前端提示"未检出夜鹭，夜师傅今天出什么COS~"，用户仍可继续上传
// - 模型不可用 -> pass=true（静默放行），避免模型故障导致站点无法上传

// 检测服务状态：前端据此决定是否展示检测入口
app.get('/api/detect/status', async (req, res) => {
    try {
        const info = await detector.status();
        res.json(info);
    } catch (error) {
        console.error('Error getting detector status:', error);
        res.json({ ready: false, error: error.message });
    }
});

// 对上传的图片做夜鹭检测（图片仅存内存，不落盘）
app.post('/api/detect', detectLimiter, uploadMemory.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '请提供图片文件（字段名 image）' });
    }

    const clientIp = getClientIp(req);
    const startedAt = Date.now();

    try {
        const result = await detector.detect(req.file.buffer);

        console.log(`[detect] ip=${clientIp} size=${req.file.size}B found=${result.found} score=${result.score} cached=${result.cached} cost=${Date.now() - startedAt}ms`);

        res.json(result);
    } catch (error) {
        // 检测失败一律放行，绝不阻断上传
        console.error('[detect] 检测失败，静默放行：', error.message);
        res.json({
            found: false,
            score: 0,
            pass: true,                 // 关键：放行
            available: false,
            verdict: '检测服务暂不可用，已跳过检测',
            detections: [],
            image: null,
            error: error.message
        });
    }
});

// 获取单只鸟类
app.get('/api/birds/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const bird = birds.find(bird => bird.id === id);

        if (!bird) {
            return res.status(404).json({ error: 'Bird not found' });
        }

        const clientIp = getClientIp(req);
        const likes = await loadLikes();
        const { tierOf } = buildGachaPool(likes);
        const tier = tierOf.get(bird.id) || DEFAULT_TIER;

        res.json({
            ...bird,
            likes: likeCountOf(likes, bird.id),
            liked: isLikedBy(likes, bird.id, clientIp),
            tier: tier.label,
            tierKey: tier.key,
            tierRate: tier.rate
        });
    } catch (error) {
        console.error('Error fetching bird:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 添加新鸟类
// 中间件顺序说明：writeBurstLimiter（防刷）-> multer（收文件/按扩展名初筛）
// -> discardUploadOnError（响应非 2xx 就删掉落盘文件）-> uploadQuotaGuard（查额度）
// -> logOperation。额度只在响应 2xx 时才真正消耗，所以"传错格式/名称不合格/超限被拒"
// 都不会白扣额度，也不会留下没人引用的图片。
app.post('/api/birds', writeBurstLimiter, upload.single('image'), discardUploadOnError, uploadQuotaGuard, logOperation, async (req, res) => {
    try {
        const { name } = req.body;

        // 验证名称长度
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        if (name.length > 10) {
            return res.status(400).json({ error: 'Name cannot exceed 10 characters' });
        }

        // 验证图片格式与大小
        const fileError = await validateImageFile(req.file);
        if (fileError) {
            // 校验失败时删掉可能已落盘的文件，避免留下孤儿图片
            if (req.file && req.file.path) {
                try { await fs.unlink(req.file.path); } catch (e) { /* ignore */ }
            }
            return res.status(400).json({ error: fileError });
        }

        const newBird = {
            id: Date.now(),
            name: name,
            imageUrl: req.file ? req.file.filename : null
        };

        birds.unshift(newBird);
        await saveData();

        // 每成功上传 1 张图片奖励 1 张单抽券
        const tickets = await grantUploadTicket(getClientIp(req));

        res.status(201).json({
            ...newBird,
            operation: res.locals.operationDesc,
            tickets
        });
    } catch (error) {
        console.error('Error creating bird:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 更新鸟类（管理员）
app.put('/api/birds/:id', writeBurstLimiter, requireAdmin, upload.single('image'), discardUploadOnError, uploadQuotaGuard, logOperation, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name } = req.body;
        const birdIndex = birds.findIndex(bird => bird.id === id);

        if (birdIndex === -1) {
            return res.status(404).json({ error: 'Bird not found' });
        }

        // 验证新图片的格式与大小
        const fileError = await validateImageFile(req.file);
        if (fileError) {
            if (req.file && req.file.path) {
                try { await fs.unlink(req.file.path); } catch (e) { /* ignore */ }
            }
            return res.status(400).json({ error: fileError });
        }

        const updatedBird = { ...birds[birdIndex] };

        if (name) updatedBird.name = name;
        if (req.file) {
            // 如果有新图片，删除旧图片
            if (updatedBird.imageUrl) {
                try {
                    await fs.unlink(path.join(__dirname, 'public/images', updatedBird.imageUrl));
                } catch (error) {
                    console.error('Error deleting old image:', error);
                }
            }

            updatedBird.imageUrl = req.file.filename;
        }

        birds[birdIndex] = updatedBird;
        await saveData();

        // 换了新图也算"上传 1 张"，同样奖励 1 张单抽券
        const tickets = req.file ? await grantUploadTicket(getClientIp(req)) : null;

        res.json({
            ...updatedBird,
            operation: res.locals.operationDesc,
            tickets
        });
    } catch (error) {
        console.error('Error updating bird:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 删除鸟类（管理员；不占每日上传额度，只受每分钟防刷限流约束）
app.delete('/api/birds/:id', writeBurstLimiter, requireAdmin, uploadQuotaGuard, logOperation, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const birdIndex = birds.findIndex(bird => bird.id === id);

        if (birdIndex === -1) {
            return res.status(404).json({ error: 'Bird not found' });
        }

        const bird = birds[birdIndex];

        // 删除关联的图片
        if (bird.imageUrl) {
            try {
                await fs.unlink(path.join(__dirname, 'public/images', bird.imageUrl));
            } catch (error) {
                console.error('Error deleting image:', error);
            }
        }

        birds.splice(birdIndex, 1);
        await saveData();

        res.json({
            message: 'Bird deleted successfully',
            operation: res.locals.operationDesc
        });
    } catch (error) {
        console.error('Error deleting bird:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 上传相关的错误统一转成 JSON，避免前端拿到 HTML 错误页
app.use((err, req, res, next) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `图片大小不能超过 ${MAX_IMAGE_LABEL}` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: '上传字段不正确，应为 image' });
    }
    if (err.message && err.message.includes('格式的图片')) {
        return res.status(400).json({ error: err.message });
    }

    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
});

// 启动服务器
async function startServer() {
    try {
        // 确保图片目录存在
        await fs.mkdir(path.join(__dirname, 'public/images'), { recursive: true });

        // 初始化数据
        await initData();

        // 启动服务器
        app.listen(PORT, () => {
            console.log('夜鹭页录已启动');
            console.log(`  网站首页 : http://localhost:${PORT}/        <-- 浏览器请打开这个`);
            console.log(`  提示     : /api 本身不是页面（访问会显示 Cannot GET /api），它只是接口前缀，`);
            console.log(`             例如 /api/birds、/api/birds/count、/api/detect/status`);
            console.log(`  配置文件 : ${CONFIG_SOURCE}（改完重启生效）`);
            console.log('  当前参数（可用环境变量覆盖，来源见括号）:');
            const row = (name, value, source) => console.log(`    ${name.padEnd(22, ' ')} ${String(value).padEnd(26, ' ')} (${source})`);
            row('端口', PORT, sourceLabel(PORT_SETTING));
            row('trust proxy', JSON.stringify(app.get('trust proxy')), sourceLabel(TRUST_PROXY_SETTING));
            row('每日上传额度/人', UPLOAD_UNLIMITED ? '不限量' : `${UPLOAD_DAILY_LIMIT} 次`,
                sourceLabel(UPLOAD_DAILY_LIMIT_SETTING));
            row('单张图片上限', MAX_IMAGE_LABEL, 'config.js:maxImageMB');
            row('写操作限流/分钟', FILE_CONFIG.writeBurstPerMinute === undefined ? 30 : asPositiveInt(FILE_CONFIG.writeBurstPerMinute, 30), 'config.js:writeBurstPerMinute');
            row('检测限流/分钟', FILE_CONFIG.detectPerMinute === undefined ? 20 : asPositiveInt(FILE_CONFIG.detectPerMinute, 20), 'config.js:detectPerMinute');
            row('管理员口令', hasCustomAdminKey
                ? '已自定义（编辑/删除需登录）'
                : '⚠ 默认口令 yelu666，请改！',
                hasCustomAdminKey
                    ? (ADMIN_KEY_HASH_SETTING.source === 'default' ? sourceLabel(ADMIN_KEY_SETTING) : sourceLabel(ADMIN_KEY_HASH_SETTING))
                    : 'default');
            row('管理员会话', `${ADMIN_SESSION_HOURS} 小时`, sourceLabel(ADMIN_SESSION_HOURS_SETTING));
            row('抽卡：每日赠送', `${DAILY_SINGLE_TICKETS} 单抽 + ${DAILY_TEN_TICKETS} 十连`, 'config.js:gacha');
            row('抽卡：档位', RARITY_TIERS.map(t => `${t.label}${(t.rate * 100).toFixed(0)}%/${(t.share * 100).toFixed(0)}%`).join(' '), 'config.js:gacha.tiers');
        });

        // 后台预热夜鹭检测模型；失败不影响服务启动，检测接口会自动降级为静默放行
        detector.init()
            .then(() => console.log('[detector] 夜鹭检测已就绪'))
            .catch(err => console.warn('[detector] 预热失败，检测将降级为静默放行：', err.message));
    } catch (error) {
        console.error('Error starting server:', error);
        process.exit(1);
    }
}

startServer();