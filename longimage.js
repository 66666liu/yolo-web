/**
 * 全站长图（图鉴海报）—— 后台用 sharp 合成
 *
 * 为什么从"浏览器 html2canvas 截图"改成服务端合成：
 *   1. 浏览器方案要先把页面换成密排网格再截图，用户能看到页面被刷掉，观感很差；
 *   2. 浏览器 canvas 有面积/边长上限（手机 Safari 约 16.7M 像素、单边 4096~8192），
 *      200 张图只能缩得很小，字和图都看不清。
 *   服务端没有这些限制，后台生成好之后直接给文件下载。
 *
 * 版面完全参照"原来那个导出"（html2canvas 截 #bird-gallery-export 的效果）：
 *   - 两行标题：text-3xl 加粗「常见鸟类辨识图鉴」+ text-base「来自：夜鹭页录 …」
 *   - 卡片网格 gallery-fixed-cols：固定 4 列、gap-8（32px）
 *   - 每张卡片：图片 object-cover 撑满 288×168（桌面端卡片高度 168），下面居中加粗名字
 *   - 卡片间距 mb-2.5（10px）
 * 唯一差别：原来只截"当前已加载的那几页"，这里把全站都排进去。
 *
 * 内存：成品原始像素约 1280×11000×3 ≈ 42MB，加上 sharp 内部一份约 90MB 峰值；
 *       所以每张缩略图都先编码成 JPEG 再交给 composite（不把 200 张原图同时展开成 raw）。
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const LAYOUT = {
    width: 1280,          // 原来是页面容器宽度（Tailwind container），这里固定 1280
    padding: 16,          // container 的 px-4
    cols: 4,              // gallery-fixed-cols
    gap: 32,              // gallery 的 md:gap-8
    imageHeight: 168,     // createBirdCard 里桌面端卡片的图片高度
    nameHeight: 42,       // 名字那一行
    rowGap: 10,           // 卡片 mb-2.5
    headerHeight: 104,    // 两行标题占的高度
    tileQuality: 84,
    posterQuality: 84
};

const TILE_BG = '#f3f4f6';
const SITE_LINE = '来自：夜鹭页录 https://yeluyelu.mynatapp.cc';
const CJK_FONT = 'Microsoft YaHei, SimHei, PingFang SC, Noto Sans CJK SC, sans-serif';

const state = {
    imagesDir: path.join(__dirname, 'public', 'images'),
    outFile: path.join(__dirname, 'long-image', 'yelu-gallery.jpg'),
    metaFile: path.join(__dirname, 'long-image', 'meta.json'),
    meta: null,
    building: null,
    timer: null,
    delayMs: 15000
};

function configure(options = {}) {
    if (options.imagesDir) state.imagesDir = options.imagesDir;
    if (options.outFile) state.outFile = options.outFile;
    if (options.metaFile) state.metaFile = options.metaFile;
    if (Number.isFinite(options.delayMs)) state.delayMs = options.delayMs;
}

function filePath() {
    return state.outFile;
}

/** 图鉴内容指纹：id + 图片名；变了就说明海报过期 */
function signatureOf(birds) {
    const items = (birds || []).filter(b => b && b.imageUrl);
    return crypto.createHash('sha1')
        .update(items.map(b => `${b.id}:${b.imageUrl}`).join('|'))
        .digest('hex');
}

function escapeXml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** 版面尺寸：所有坐标都由这里算出来，避免各处各写一份 */
function layoutOf(count) {
    const { width, padding, cols, gap, imageHeight, nameHeight, rowGap, headerHeight } = LAYOUT;
    const rows = Math.max(1, Math.ceil(Math.max(0, count) / cols));
    const cellWidth = (width - padding * 2 - gap * (cols - 1)) / cols;
    return {
        rows,
        width,
        cellWidth,
        imageHeight,
        nameHeight,
        gap,
        padding,
        headerHeight,
        height: headerHeight + rows * (imageHeight + nameHeight) + (rows - 1) * rowGap + padding
    };
}

/** 某个格子的左上角坐标 */
function cellAt(index, layout) {
    return {
        left: layout.padding + (index % LAYOUT.cols) * (layout.cellWidth + layout.gap),
        top: layout.headerHeight + Math.floor(index / LAYOUT.cols) * (layout.imageHeight + layout.nameHeight + LAYOUT.rowGap)
    };
}

/** 标题层：一条和整图等宽的 SVG（只有两行字，栅格化很便宜） */
function buildHeaderSvg(count, layout) {
    const x = layout.padding + 4;   // 原来是 ml-1
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.headerHeight}">
        <text x="${x}" y="52" font-family="${CJK_FONT}" font-size="30" font-weight="bold" fill="#000000">常见鸟类辨识图鉴</text>
        <text x="${x}" y="88" font-family="${CJK_FONT}" font-size="16" fill="#000000">${escapeXml(SITE_LINE)}</text>
    </svg>`);
}

/** 一行名字：一行一条小 SVG，比整图一张大 SVG 省很多内存 */
function buildNameRowSvg(rowItems, rowIndex, layout) {
    const top = layout.headerHeight + rowIndex * (layout.imageHeight + layout.nameHeight + LAYOUT.rowGap) + layout.imageHeight;
    const texts = rowItems.map((bird, i) => {
        const cx = layout.padding + i * (layout.cellWidth + layout.gap) + layout.cellWidth / 2;
        return `<text x="${Number(cx.toFixed(1))}" y="${layout.nameHeight - 14}" text-anchor="middle"
            font-family="${CJK_FONT}" font-size="24" font-weight="bold" fill="#111111">${escapeXml(bird.name)}</text>`;
    }).join('');
    return {
        input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.nameHeight}">${texts}</svg>`),
        left: 0,
        top
    };
}

/** 并发受控的 map，避免 200 张图同时解码 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

async function writeMeta(meta) {
    const tmp = `${state.metaFile}.tmp`;
    await fs.mkdir(path.dirname(state.metaFile), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fs.rename(tmp, state.metaFile);
}

async function readMeta() {
    try {
        const raw = await fs.readFile(state.metaFile, 'utf8');
        const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return null;
    }
}

/** 真正干活：拼图并落盘 */
async function doBuild(birds) {
    const startedAt = Date.now();
    const items = (birds || []).filter(b => b && b.imageUrl);
    if (!items.length) throw new Error('图鉴为空，无法生成长图');

    const layout = layoutOf(items.length);

    // ① 缩略图：按桌面端卡片尺寸 object-cover 裁切，先编码再交给 composite
    let skipped = 0;
    const tiles = await mapLimit(items, 4, async (bird, index) => {
        const { left, top } = cellAt(index, layout);
        const file = path.join(state.imagesDir, path.basename(bird.imageUrl));
        try {
            const input = await sharp(file, { failOn: 'none' })
                .flatten({ background: TILE_BG })
                .resize(Math.round(layout.cellWidth), layout.imageHeight, { fit: 'cover' })
                .jpeg({ quality: LAYOUT.tileQuality })
                .toBuffer();
            return { input, left: Math.round(left), top };
        } catch (error) {
            skipped++;
            console.warn(`[longimage] 跳过无法解码的图 ${bird.imageUrl}：`, error.message);
            return null;
        }
    });

    // ② 文字层：标题一条 + 每行名字一条
    const overlays = [{ input: buildHeaderSvg(items.length, layout), left: 0, top: 0 }];
    for (let row = 0; row < layout.rows; row++) {
        const rowItems = items.slice(row * LAYOUT.cols, row * LAYOUT.cols + LAYOUT.cols);
        overlays.push(buildNameRowSvg(rowItems, row, layout));
    }

    // ③ 合成
    await fs.mkdir(path.dirname(state.outFile), { recursive: true });
    const tmp = `${state.outFile}.tmp`;
    const info = await sharp({
        create: { width: layout.width, height: layout.height, channels: 3, background: '#ffffff' }
    })
        .composite([...tiles.filter(Boolean), ...overlays])
        .jpeg({ quality: LAYOUT.posterQuality, mozjpeg: true })
        .toFile(tmp);
    await fs.rename(tmp, state.outFile);

    const meta = {
        generatedAt: new Date().toISOString(),
        count: items.length,
        skipped,
        width: info.width,
        height: info.height,
        bytes: info.size,
        columns: LAYOUT.cols,
        signature: signatureOf(items),
        elapsedMs: Date.now() - startedAt
    };
    state.meta = meta;
    await writeMeta(meta);
    console.log(`[longimage] 全站长图已生成：${meta.width}×${meta.height}，${(meta.bytes / 1048576).toFixed(1)}MB，`
        + `${meta.count} 张（跳过 ${skipped}），${LAYOUT.cols} 列，用时 ${(meta.elapsedMs / 1000).toFixed(1)}s`);
    return meta;
}

/** 同一时刻只跑一个生成任务 */
function build(birds) {
    if (state.building) return state.building;
    state.building = doBuild(birds)
        .catch(error => {
            console.error('[longimage] 生成失败：', error.message);
            throw error;
        })
        .finally(() => { state.building = null; });
    return state.building;
}

/** 图鉴变了就排一次延迟重建（避免连续上传时反复重算） */
function scheduleRebuild(birds, delayMs) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
        state.timer = null;
        build(birds).catch(() => { /* 已打日志 */ });
    }, Number.isFinite(delayMs) ? delayMs : state.delayMs);
    if (state.timer.unref) state.timer.unref();
}

/** 服务启动时调用：缺图或过期就在后台补一张 */
async function ensureFresh(birds) {
    if (!state.meta) state.meta = await readMeta();
    if (state.meta && state.meta.signature === signatureOf(birds)) {
        const exists = await fs.access(state.outFile).then(() => true).catch(() => false);
        if (exists) return { ...state.meta, fresh: true };
    }
    const meta = await build(birds);
    return { ...meta, fresh: true };
}

/** 只启动后台生成，不等结果（接口里用，避免请求被卡十几秒） */
function startBuildIfStale(birds) {
    if (state.building) return;
    build(birds).catch(() => { /* 已打日志 */ });
}

function status(birds) {
    const meta = state.meta;
    return {
        ready: Boolean(meta),
        building: Boolean(state.building),
        stale: Boolean(meta) && meta.signature !== signatureOf(birds),
        url: '/api/gacha/export/long-image',
        count: meta ? meta.count : (birds || []).filter(b => b && b.imageUrl).length,
        columns: LAYOUT.cols,
        width: meta ? meta.width : null,
        height: meta ? meta.height : null,
        bytes: meta ? meta.bytes : null,
        generatedAt: meta ? meta.generatedAt : null,
        elapsedMs: meta ? meta.elapsedMs : null
    };
}

module.exports = {
    configure,
    layoutOf,
    signatureOf,
    build,
    ensureFresh,
    startBuildIfStale,
    scheduleRebuild,
    status,
    filePath
};
