/**
 * 全站长图（图鉴海报）—— 后台用 sharp 合成
 *
 * 为什么从"浏览器 html2canvas 截图"改成服务端合成：
 *   1. 浏览器方案要先把页面换成密排网格再截图，用户能看到页面被刷掉，观感很差；
 *   2. 浏览器 canvas 有面积/边长上限（手机 Safari 约 16.7M 像素、单边 4096~8192），
 *      200 张图只能缩得很小，字和图都看不清。
 *   服务端没有这些限制，后台生成好之后直接给文件下载。
 *
 * 版面照 long-image/导出参考示意（忽略顶部文字）.jpg 量出来的尺寸复刻：
 *   - 一行标题：加粗「夜鹭拟态与辨别图鉴」，字高 45，左边贴内容区。
 *     只有这一行，来源网站那行不要
 *   - 4 列网格，列间距 34、左右留白 18，算下来列宽 140
 *   - 每张卡片：图片 object-cover 撑满 140×140（**方形**），下面居中加粗名字、字高 35
 *   - 行距 216（图片 140 + 名字带 56 + 行间 20），参考图实测 217
 *   - 例外：SVG 不会自动换行，名字超过 4 个字就会压到左右邻居上，所以名字要先量宽
 *     （见 fitName），长的缩字号或折成两行，该行行高随之变高
 *
 * 关键：整图宽度只有 696（不是页面的 1280）。之前按 1280 出图，手机上把整图缩到屏幕宽
 * 只剩 0.30 倍，24px 的名字缩完只有 7px，根本看不清；696 宽缩到手机屏是 0.56 倍，
 * 名字还有约 19px，图片也有 78px 见方，和参考图在手机上看到的效果一致。
 *
 * 内存：成品原始像素约 696×11000×3 ≈ 23MB，sharp 内部再一份，峰值比 1280 宽那版低得多；
 *       每张缩略图仍先编码成 JPEG 再交给 composite（不把 200 张原图同时展开成 raw）。
 *
 * 按需生成：重算一次约 2 秒，其中大头是"把 250 个图层合成到 2300 万像素画布上再编码 JPEG"
 * （缩略图只占 0.4 秒，且质量参数几乎不影响耗时，瓶颈是画布像素数）。
 * 长图是抽卡「终极」才有的奖品，绝大多数时间没人下载，所以图鉴变动时**只在后台标记过期**，
 * 等真有人点下载（/api/gacha/export/long-image 看到 stale）才实际开算。
 * 唯一的例外是服务启动时的 ensureFresh —— 一次进程只跑一次，为的是让第一次下载不用等。
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// 全部数值来自参考图的实测（列宽 140 = (696-36-3*34)/4）
const LAYOUT = {
    width: 696,           // 参考图总宽（不是页面容器宽度）
    padding: 18,          // 参考图里第一列图片的左边缘
    cols: 4,              // 参考图 4 列
    gap: 34,              // 参考图列间距
    imageHeight: 140,     // = 列宽，方形；参考图图片块则是 134×133
    nameHeight: 56,       // 名字那一行（参考图名字带约 60）
    rowGap: 20,           // 行间留白；合计行距 216，参考图实测 217
    headerHeight: 110,    // 标题一行 + 与首行的留白（参考图首行图片顶在 y=116）
    titleFontSize: 45,    // 参考图标题字高 45
    titleBaseline: 72,    // 让标题字落在参考图的位置（y 实测 34-78）
    nameFontSize: 35,     // 参考图名字字高 36（一行放得下时的字号）
    tileQuality: 84,
    posterQuality: 84
};

// ---------- 名字折行 ----------
// SVG <text> 不会自动换行，"蓝长腺珊瑚蛇"这种 6 个字按 35px 画出来有 210px 宽，
// 而格子只有 140px，会直接压到左右邻居身上。所以这里先量宽再决定字号/折行。
const NAME_FILL = 0.96;       // 名字最多占格宽的多少（留一点气口，别贴着邻居）
const NAME_LINE_HEIGHT = 1.25; // 行高 = 字号 × 1.25（和参考图的行距观感一致）
// 一行的字号低于这个数就宁可折成两行。取 30 而不是更小：5 个字缩一行只剩 26px，
// 而 6 个字折两行有 35px —— 阈值太低会让长名字反而比短名字大，看着别扭。
const NAME_MINSIZE_ONE = 30;
// 折行时不能落在行末 / 行首的标点（"鸵鸟（幼）"折成"鸵鸟（"/"幼）"就难看了）
const NO_LINE_END = '（［｛【《「『““‘';
const NO_LINE_START = '、。，．！？：；）］｝】》」』””’%‰℃…—～·';
// 名字带 = 文字块 + 上下留白；取成让"一行 35px"的高度正好等于参考图量到的 56
const NAME_BAND_PADDING = LAYOUT.nameHeight - LAYOUT.nameFontSize * NAME_LINE_HEIGHT;

// 版面版本：改动 LAYOUT（尺寸/列数/是否带来源行…）时必须 +1。
// 它参与 contentSignature，否则版面改了但图鉴内容没变时，旧海报会被判定为"还是新的"，永远不重算。
const LAYOUT_VERSION = 6;

const TILE_BG = '#f3f4f6';
const POSTER_TITLE = '夜鹭拟态与辨别图鉴';
const CJK_FONT = 'Microsoft YaHei, SimHei, PingFang SC, Noto Sans CJK SC, sans-serif';

const state = {
    imagesDir: path.join(__dirname, 'public', 'images'),
    outFile: path.join(__dirname, 'long-image', 'yelu-gallery.jpg'),
    metaFile: path.join(__dirname, 'long-image', 'meta.json'),
    meta: null,
    building: null
};

function configure(options = {}) {
    if (options.imagesDir) state.imagesDir = options.imagesDir;
    if (options.outFile) state.outFile = options.outFile;
    if (options.metaFile) state.metaFile = options.metaFile;
}

function filePath() {
    return state.outFile;
}

/** 图鉴内容指纹：版面版本 + id + 图片名；任意一项变了都说明海报过期 */
function signatureOf(birds) {
    const items = (birds || []).filter(b => b && b.imageUrl);
    return crypto.createHash('sha1')
        .update(`layout:${LAYOUT_VERSION}|`)
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

/** 单个字符占多少个字号宽：汉字/全角约 1 个字身，ASCII 约 0.55 */
function charWidth(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x2e80 && cp <= 0x9fff) return 1;    // 汉字、假名
    if (cp >= 0xff00 && cp <= 0xffef) return 1;    // 全角字母数字、全角括号
    if (cp >= 0x3000 && cp <= 0x303f) return 1;    // 全角标点
    if (cp >= 0x1f300) return 1.2;                 // emoji
    if (ch === ' ') return 0.3;
    if (cp < 0x80) return 0.55;                    // 拉丁字母、数字
    return 0.85;
}

/** 一段文字在指定字号下大约多宽（像素） */
function textWidth(text, fontSize) {
    let em = 0;
    for (const ch of String(text == null ? '' : text)) em += charWidth(ch);
    return em * fontSize;
}

/**
 * 给一个名字挑字号和折行。
 * 一行塞得下就用参考图的 35px；塞不下先缩字号，但缩到 26px 还不行就折成两行 ——
 * 折行后的字号往往比硬缩还大（"蓝长腺珊瑚蛇" 6 个字：硬缩进一行只剩 22px，折成 3+3 有 35px）。
 * 折行切点取"两行里较长那行最短"的那个，等价于折行后字号能取到最大。
 */
function fitName(name, maxWidth) {
    const text = String(name == null ? '' : name);
    const chars = [...text];
    if (!chars.length) return { lines: [''], fontSize: LAYOUT.nameFontSize };

    const oneLine = textWidth(text, LAYOUT.nameFontSize);
    if (oneLine <= maxWidth) return { lines: [text], fontSize: LAYOUT.nameFontSize };

    const shrunk = (LAYOUT.nameFontSize * maxWidth) / oneLine;
    if (shrunk >= NAME_MINSIZE_ONE) return { lines: [text], fontSize: Math.floor(shrunk) };

    // 折行切点：先避开断在标点两侧的难看切法，再取"较长那行最短"（= 折完字号最大），
    // 一样长时取更均衡的切法。极端情况（整串都是标点）全部切点都不合法，就退回正中间切。
    let cut = Math.ceil(chars.length / 2);
    let bestWidest = Infinity;
    let bestGap = Infinity;
    for (let i = 1; i < chars.length; i++) {
        if (NO_LINE_END.includes(chars[i - 1]) || NO_LINE_START.includes(chars[i])) continue;
        const left = textWidth(chars.slice(0, i).join(''), 1);   // 按 1em 字号算 = 占多少个字身
        const right = textWidth(chars.slice(i).join(''), 1);
        const widest = Math.max(left, right);
        const gap = Math.abs(left - right);
        if (widest < bestWidest || (widest === bestWidest && gap < bestGap)) {
            cut = i;
            bestWidest = widest;
            bestGap = gap;
        }
    }

    const widest = bestWidest === Infinity
        ? Math.max(
            textWidth(chars.slice(0, cut).join(''), 1),
            textWidth(chars.slice(cut).join(''), 1))
        : bestWidest;

    return {
        lines: [chars.slice(0, cut).join(''), chars.slice(cut).join('')],
        fontSize: Math.min(LAYOUT.nameFontSize, Math.floor(maxWidth / widest))
    };
}

/** 名字带的高度：文字块 + 上下留白。一行 35px 时正好等于参考图量到的 56 */
function nameBandHeight(fit) {
    const textHeight = fit.lines.length * fit.fontSize * NAME_LINE_HEIGHT;
    return Math.round(Math.max(LAYOUT.nameHeight, textHeight + NAME_BAND_PADDING));
}

/**
 * 版面尺寸：所有坐标都由这里算出来，避免各处各写一份。
 * 行高按各行"最高的那个名字带"算 —— 200 张里只有 8 个名字会折行，
 * 让另外几十行陪着一起长高会把海报白白拉长一大截。
 */
function layoutOf(items) {
    const list = items || [];
    const { width, padding, cols, gap, imageHeight, nameHeight, rowGap, headerHeight } = LAYOUT;
    const rows = Math.max(1, Math.ceil(Math.max(0, list.length) / cols));
    const cellWidth = (width - padding * 2 - gap * (cols - 1)) / cols;

    const fits = list.map(bird => fitName(bird && bird.name, cellWidth * NAME_FILL));
    const bands = [];
    for (let row = 0; row < rows; row++) {
        let band = nameHeight;
        for (let i = row * cols; i < Math.min(list.length, (row + 1) * cols); i++) {
            band = Math.max(band, nameBandHeight(fits[i]));
        }
        bands.push(band);
    }

    const tops = [];
    let cursor = headerHeight;
    for (let row = 0; row < rows; row++) {
        tops.push(cursor);
        cursor += imageHeight + bands[row] + rowGap;
    }

    return {
        rows,
        width,
        cellWidth,
        imageHeight,
        nameHeight,
        gap,
        padding,
        headerHeight,
        bands,
        tops,
        fits,
        height: cursor - rowGap + padding   // 最后一行后面不留行距，改由底部留白收尾
    };
}

/** 某个格子的左上角坐标 */
function cellAt(index, layout) {
    return {
        left: layout.padding + (index % LAYOUT.cols) * (layout.cellWidth + layout.gap),
        top: layout.tops[Math.floor(index / LAYOUT.cols)]
    };
}

/** 标题层：一条和整图等宽的 SVG（只有一行字，栅格化很便宜） */
function buildHeaderSvg(layout) {
    const x = layout.padding + 4;   // 原来是 ml-1
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.headerHeight}">
        <text x="${x}" y="${LAYOUT.titleBaseline}" font-family="${CJK_FONT}" font-size="${LAYOUT.titleFontSize}" font-weight="bold" fill="#000000">${escapeXml(POSTER_TITLE)}</text>
    </svg>`);
}

/** 一行名字：一行一条小 SVG，比整图一张大 SVG 省很多内存 */
function buildNameRowSvg(rowItems, rowIndex, layout) {
    const top = layout.tops[rowIndex] + layout.imageHeight;
    const band = layout.bands[rowIndex];
    const texts = rowItems.map((_, i) => {
        const fit = layout.fits[rowIndex * LAYOUT.cols + i];
        const cx = layout.padding + i * (layout.cellWidth + layout.gap) + layout.cellWidth / 2;
        // 文字块在名字带里垂直居中：行盒高 = 字号×1.25，基线落在行盒内 0.88em 处，
        // 汉字的字身约在 -0.12em~0.88em，视觉中心正好压住行盒中心
        const lineHeight = fit.fontSize * NAME_LINE_HEIGHT;
        const first = (band - fit.lines.length * lineHeight) / 2 + fit.fontSize * 0.88;
        return fit.lines.map((line, li) =>
            `<text x="${Number(cx.toFixed(1))}" y="${Number((first + li * lineHeight).toFixed(1))}" text-anchor="middle"
            font-family="${CJK_FONT}" font-size="${fit.fontSize}" font-weight="bold" fill="#111111">${escapeXml(line)}</text>`
        ).join('');
    }).join('');
    return {
        input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${band}">${texts}</svg>`),
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

    const layout = layoutOf(items);

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
    const overlays = [{ input: buildHeaderSvg(layout), left: 0, top: 0 }];
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
    status,
    filePath
};
