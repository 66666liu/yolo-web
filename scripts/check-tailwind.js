/**
 * 前端静态自检：三项都不依赖浏览器。
 *
 * 为什么需要：
 *   页面以前全靠 CDN（cdn.tailwindcss.com 实时编译 + jsDelivr 发图标字体），
 *   换成本地文件后，"少了什么"在服务端完全看不出来 —— 不报错、不 404 到日志里，
 *   只有用户看到"某个地方样式没了 / 图标变成方块"。没浏览器的情况下只能靠静态比对。
 *
 * 三项检查：
 *   1. 类名   —— 源码里出现的每个 Tailwind 类名，output.css 里有没有对应规则
 *   2. 资源   —— html 的 src/href、css 的 url() 指向的本地文件是否真的存在
 *   3. 图标   —— 页面用的 fa-* 图标名在 font-awesome.min.css 里有没有定义
 *   （第 2、3 项各对应一次真实事故：字体文件没跟着搬进仓库、fa-dove 这个名字 FA4 里根本没有）
 *
 * 用法：npm run check:css   （改完 index.html / input.css，或哪天页面看着不对时跑一下）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const BUILD_OUTPUT = 'output.css';          // 构建产物自己，不能拿来当"已定义"的依据
const FA_CSS = 'font-awesome.min.css';

/** 第三方库目录：里面的字符串字面量成千上万，扫出来全是 use / strict / onMouseMove 这种噪音 */
const SKIP_DIRS = new Set(['live2d-vendor']);

/** 递归收集 public/ 下符合后缀的文件 */
function walk(dir, exts) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full, exts);
        return exts.some(e => entry.name.endsWith(e)) ? [full] : [];
    });
}
const rel = file => path.relative(root, file);
const codeFiles = () => walk(publicDir, ['.html', '.js']);

// ══════════════════════════ 1. 类名覆盖 ══════════════════════════

const css = fs.readFileSync(path.join(publicDir, BUILD_OUTPUT), 'utf8');

/**
 * 手写的 CSS 里定义的类名：内联 <style> 块 + public 下的 .css 文件
 * （font-awesome.min.css 的 .fa-*、index.html 里的 .skeleton / .gacha-flip 等）。
 * 这些不是 Tailwind 生成的，不该报缺失。
 * 要排除 output.css —— 否则漏掉的类名会被构建产物自己"证明"存在。
 */
function locallyDefined() {
    const out = new Set();
    const take = text => {
        for (const m of text.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]);
    };

    for (const file of codeFiles()) {
        if (!file.endsWith('.html')) continue;
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) take(m[1]);
    }
    for (const file of walk(publicDir, ['.css'])) {
        if (path.basename(file) === BUILD_OUTPUT) continue;
        take(fs.readFileSync(file, 'utf8'));
    }
    return out;
}

/** 纯 JS 钩子 / 导出标记：只用来 querySelector 或标记导出范围，本来就没有样式 */
const NOT_STYLED = new Set(['no-export', 'export-area', 'edit-btn', 'delete-btn', 'like-count']);

/**
 * 抠出"像类名列表"的字符串。
 * 两种来源：class="..." 属性，以及 JS 里形如 'fixed bottom-4 border-2' 的字面量。
 * 判断标准放宽一点没关系 —— 误报只是多查几个词，漏报才是要命的。
 */
function candidatesOf(text) {
    const out = new Set();
    const push = raw => {
        // 模板串里的 ${...} 是运行时才知道的值，这里只留字面部分：
        // 真正会拼进去的那些类名（TIER_STYLE 等）本身也是字面量，会被单独扫到
        for (const token of String(raw).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
            if (/^[a-z][a-zA-Z0-9-]*([-:/[\]().%,#!][a-zA-Z0-9-:/[\]().%,#!]*)*$/.test(token)) {
                out.add(token);
            }
        }
    };

    for (const m of text.matchAll(/class\s*=\s*["'`]([^"'`]*)["'`]/g)) push(m[1]);
    // JS 里成串的类名：整段字面量里每一块都像类名，才认为它是类名列表
    for (const m of text.matchAll(/["'`]([^"'`\n]{6,})["'`]/g)) {
        const parts = m[1].trim().split(/\s+/);
        if (parts.length >= 2 && parts.every(p => /^[a-z]/.test(p))) push(m[1]);
    }
    return out;
}

/** Tailwind 在 CSS 里会把这些字符转义 */
const escapeClass = cls => cls.replace(/[:/[\]().%,#!]/g, ch => '\\' + ch);

/** 判断某个类名在 css 里有没有对应的规则（要求后面是边界，避免 text-lg 命中 text-lgx） */
function hasRule(cls) {
    const escaped = escapeClass(cls).replace(/[.*+?^${}()|[\]\\]/g, ch => '\\' + ch);
    return new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`).test(css);
}

const files = codeFiles();
const all = new Map();   // 类名 -> 出现的文件
for (const file of files) {
    for (const cls of candidatesOf(fs.readFileSync(file, 'utf8'))) {
        if (!all.has(cls)) all.set(cls, rel(file));
    }
}

const local = locallyDefined();
const missingClasses = [...all.entries()].filter(([cls]) =>
    !hasRule(cls)
    && !local.has(cls)                 // 手写 CSS 里定义的（.skeleton、.fa-* …）
    && !NOT_STYLED.has(cls)            // 纯 JS 钩子
    && !/^(group|peer)$/.test(cls)     // group-hover: 这类前缀的宿主
);

// ══════════════════════════ 2. 本地资源引用 ══════════════════════════
//
// 只检查"看起来是本地路径"的引用：外部 URL、data:、锚点、以及含 ${} 的模板串都跳过。
// 事故原型：font-awesome.min.css 里 url('../fonts/fontawesome-webfont.woff2') 指向的
// 字体文件从来没进过仓库（以前靠 CDN 供着），结果整站图标全变方块。

const isLocalRef = url => url
    && !/^(https?:)?\/\//i.test(url)
    && !/^data:/i.test(url)
    && !/^(mailto|tel):/i.test(url)
    && !url.startsWith('#')
    && !url.includes('${');

function missingAssets() {
    const out = [];

    /**
     * 按**浏览器**的规则解析相对路径，而不是按文件系统。
     * public/ 是站点根目录，`../` 到根就夹住了 —— 比如 public/font-awesome.min.css
     * 里的 url('../fonts/x.woff2')，浏览器拿到的是 /fonts/x.woff2（不是仓库根的 fonts/）。
     */
    const fileFor = (file, url) => {
        const webDir = '/' + path.relative(publicDir, path.dirname(file)).split(path.sep).join('/');
        const resolved = path.posix.normalize(`${webDir}/${url.split(/[?#]/)[0]}`);
        return path.join(publicDir, resolved);
    };

    const check = (file, url) => {
        if (!isLocalRef(url)) return;
        if (!fs.existsSync(fileFor(file, url))) out.push(`${url}   (${rel(file)})`);
    };

    for (const file of files) {
        if (!file.endsWith('.html')) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) check(file, m[1].trim());
    }

    for (const file of walk(publicDir, ['.css'])) {
        // 先剥掉注释，免得把 /* ... url() ... */ 这种说明文字当成引用
        const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) check(file, m[1].trim());
    }

    return [...new Set(out)];
}

// ══════════════════════════ 3. Font Awesome 图标名 ══════════════════════════
//
// FA4 里没有的图标名（比如 fa-dove 是 FA5 才加的）不会报错，页面只留一块空白。
// 判定"这个名字有效"的标准：css 里有 .fa-x:before{content:...}（图标）
// 或 .fa-x{...}（修饰类，如 fa-spin / fa-lg）。两者都没有才算漏。

function missingIcons() {
    const faCss = fs.readFileSync(path.join(publicDir, FA_CSS), 'utf8');
    const used = new Set();

    for (const file of files) {
        if (!file.endsWith('.html')) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/class\s*=\s*["'`]([^"'`]*)["'`]/g)) {
            const tokens = m[1].split(/\s+/).filter(Boolean);
            // 只在真带 fa 基类的元素里找，避免把业务类名里凑巧的 fa-xxx 当图标
            if (!tokens.includes('fa')) continue;
            for (const token of tokens) if (/^fa-[a-z0-9-]+$/.test(token)) used.add(token);
        }
    }

    return [...used]
        .filter(name => !new RegExp(`\\.${name}:before`).test(faCss) && !new RegExp(`\\.${name}\\{`).test(faCss))
        .sort();
}

// ══════════════════════════ 汇总 ══════════════════════════

const assets = missingAssets();
const icons = missingIcons();

console.log(`扫描 ${files.length} 个文件，找到 ${all.size} 个类名`);

let failed = false;

if (missingClasses.length) {
    failed = true;
    console.log(`\n⚠️  ${missingClasses.length} 个类名在 ${BUILD_OUTPUT} 里找不到规则：`);
    for (const [cls, file] of missingClasses) console.log(`   ${cls}   (${file})`);
    console.log('   真的类名就说明静态构建漏了它 —— 通常是运行时拼出来的（bg-${color}-500 这种），');
    console.log('   要么改成完整字面量，要么加进 tailwind.config.js 的 safelist。');
} else {
    console.log(`\n✅ 类名：${BUILD_OUTPUT} 覆盖全部 ${all.size} 个`);
}

if (assets.length) {
    failed = true;
    console.log(`\n⚠️  ${assets.length} 个本地资源引用指向不存在的文件：`);
    for (const a of assets) console.log(`   ${a}`);
    console.log('   页面不会报错，只会静默少样式/少图。要么把文件放进去，要么改引用。');
} else {
    console.log('✅ 本地资源：引用的文件都在');
}

if (icons.length) {
    failed = true;
    console.log(`\n⚠️  ${icons.length} 个 Font Awesome 图标名在 ${FA_CSS} 里没有定义：`);
    for (const i of icons) console.log(`   ${i}`);
    console.log('   这些名字渲染出来是空白（不会报错）。FA4.7 里没有的多半是 FA5 才加的，换个存在的。');
} else {
    console.log('✅ 图标：页面用到的 fa-* 在 FA 里全都有');
}

process.exit(failed ? 1 : 0);
