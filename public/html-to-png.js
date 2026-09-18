/**
 * 将 HTML 元素转换为 PNG 图像（支持导出时显示特定元素）
 * @param {HTMLElement} element - 要转换的 HTML 元素
 * @param {Object} options - 转换选项
 * @param {number} options.scale - 缩放比例，默认 2
 * @param {string} options.backgroundColor - 背景颜色，默认白色
 * @param {boolean} options.useCORS - 是否尝试跨域资源加载，默认 true
 * @param {Array} options.excludeClasses - 要排除的CSS类，默认 ['no-export']
 * @param {Array} options.exportOnlyClasses - 仅在导出时显示的CSS类，默认 ['.export-only']
 * @param {Array} options.screenOnlyClasses - 仅在屏幕显示时的CSS类，默认 ['.screen-only']
 * @returns {Promise<string>} - 返回包含 PNG 数据的 DataURL
 */
async function convertHtmlToPng(element, options = {}) {
    // 设置默认选项
    const {
        scale = 1,
        backgroundColor = '#ffffff',
        useCORS = true,
        excludeClasses = ['no-export'],
        exportOnlyClasses = ['.export-only'],
        screenOnlyClasses = ['.screen-only']
    } = options;

    // 显示加载状态
    showLoading(true);

    try {
        // 使用 onclone 回调在克隆DOM时处理元素显示状态
        const canvas = await html2canvas(element, {
            scale,
            backgroundColor,
            useCORS,
            logging: false,
            onclone: (clonedDoc) => {
                // 1. 移除所有需要排除的元素
                excludeClasses.forEach(className => {
                    const elements = clonedDoc.querySelectorAll(`.${className}`);
                    elements.forEach(el => el.remove());
                });

                // 2. 强制显示仅导出时可见的元素
                exportOnlyClasses.forEach(selector => {
                    const elements = clonedDoc.querySelectorAll(selector);
                    elements.forEach(el => {
                        // 必须用 setProperty：内联样式不接受 "block !important" 这种写法，
                        // 旧写法会被浏览器整条丢弃，.export-only 的标题就永远出不来
                        el.style.setProperty('display', 'block', 'important');
                    });
                });

                // 3. 强制隐藏仅屏幕显示的元素
                screenOnlyClasses.forEach(selector => {
                    const elements = clonedDoc.querySelectorAll(selector);
                    elements.forEach(el => {
                        el.style.setProperty('display', 'none', 'important');
                    });
                });

                // 4. 示例：可额外移除特定元素（如页脚）
                const footer = clonedDoc.querySelector('footer');
                if (footer) footer.remove();
            }
        });

        return canvas.toDataURL('image/png', 0.9);
    } catch (error) {
        console.error('HTML 转 PNG 失败:', error);
        throw new Error('转换过程中发生错误，请重试');
    } finally {
        showLoading(false);
    }
}

/**
 * 下载 PNG 图像
 * @param {string} dataUrl - 图像数据 URL
 * @param {string} filename - 下载的文件名，默认 'screenshot.png'
 */
function downloadPng(dataUrl, filename = 'screenshot.png') {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * 将 HTML 元素转换为 JPG 图像（支持导出时显示特定元素）
 * @param {HTMLElement} element - 要转换的 HTML 元素
 * @param {Object} options - 转换选项
 * @param {number} options.scale - 缩放比例，默认 2
 * @param {string} options.backgroundColor - 背景颜色，默认白色
 * @param {boolean} options.useCORS - 是否尝试跨域资源加载，默认 true
 * @param {Array} options.excludeClasses - 要排除的CSS类，默认 ['no-export']
 * @param {Array} options.exportOnlyClasses - 仅在导出时显示的CSS类，默认 ['.export-only']
 * @param {Array} options.screenOnlyClasses - 仅在屏幕显示时的CSS类，默认 ['.screen-only']
 * @returns {Promise<string>} - 返回包含 JPG 数据的 DataURL
 */
async function convertHtmlToJpg(element, options = {}) {
    // 设置默认选项
    const {
        scale = 1,
        backgroundColor = '#ffffff',
        useCORS = true,
        excludeClasses = ['no-export'],
        exportOnlyClasses = ['.export-only'],
        screenOnlyClasses = ['.screen-only']
    } = options;

    // 显示加载状态
    showLoading(true);

    try {
        // 使用 onclone 回调在克隆DOM时处理元素显示状态
        const canvas = await html2canvas(element, {
            scale,
            backgroundColor,
            useCORS,
            logging: false,
            onclone: (clonedDoc) => {
                // 1. 移除所有需要排除的元素
                excludeClasses.forEach(className => {
                    const elements = clonedDoc.querySelectorAll(`.${className}`);
                    elements.forEach(el => el.remove());
                });

                // 2. 强制显示仅导出时可见的元素
                exportOnlyClasses.forEach(selector => {
                    const elements = clonedDoc.querySelectorAll(selector);
                    elements.forEach(el => {
                        // 必须用 setProperty：内联样式不接受 "block !important" 这种写法，
                        // 旧写法会被浏览器整条丢弃，.export-only 的标题就永远出不来
                        el.style.setProperty('display', 'block', 'important');
                    });
                });

                // 3. 强制隐藏仅屏幕显示的元素
                screenOnlyClasses.forEach(selector => {
                    const elements = clonedDoc.querySelectorAll(selector);
                    elements.forEach(el => {
                        el.style.setProperty('display', 'none', 'important');
                    });
                });

                // 4. 示例：可额外移除特定元素（如页脚）
                const footer = clonedDoc.querySelector('footer');
                if (footer) footer.remove();
            }
        });

        // 修改为 JPG 格式，质量设为 0.9
        return canvas.toDataURL('image/jpeg', 0.9);
    } catch (error) {
        console.error('HTML 转 JPG 失败:', error);
        throw new Error('转换过程中发生错误，请重试');
    } finally {
        showLoading(false);
    }
}

/**
 * 下载 JPG 图像
 * @param {string} dataUrl - 图像数据 URL
 * @param {string} filename - 下载的文件名，默认 'screenshot.jpg'
 */
function downloadJpg(dataUrl, filename = 'screenshot.jpg') {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * 显示或隐藏加载状态
 * @param {boolean} isLoading - 是否处于加载状态
 */
function showLoading(isLoading) {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = isLoading ? 'flex' : 'none';
    }
}

/**
 * 显示通知消息
 * @param {string} message - 通知消息内容
 * @param {string} type - 通知类型，可选 'success', 'error', 'info'
 */
function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    if (!notification) return;

    // 设置通知类型样式
    notification.className = 'fixed bottom-4 right-4 px-4 py-2 border-2 p-4 transform transition-all duration-500 translate-y-20 opacity-0 z-50';
    notification.classList.add('text-white');

    switch (type) {
        case 'success':
            notification.classList.add('bg-green-500', 'border-green-700');
            break;
        case 'error':
            notification.classList.add('bg-red-500', 'border-red-700');
            break;
        case 'info':
        default:
            notification.classList.add('bg-blue-500', 'border-blue-700');
            break;
    }

    // 设置通知内容
    notification.textContent = message;

    // 显示通知
    setTimeout(() => {
        notification.classList.remove('translate-y-20', 'opacity-0');
    }, 10);

    // 自动隐藏通知
    setTimeout(() => {
        notification.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
}

// 初始化页面事件
/**
 * 导出当前图鉴长图（抽卡"终极"大奖）。
 *
 * 导出的是**全站图片**，不是页面上已加载的那几页：
 *   页面脚本的 window.yeluPrepareFullExport 会把 /api/birds 全部分页拉下来，
 *   另建一块 8 列密排的导出布局，导出完再还原页面。拿不到它时退化为导出当前区域。
 *
 * @returns {Promise<{dataUrl: string, width: number, height: number, count: number, scale: number}>}
 */
async function exportLongImage() {
    let target = document.getElementById('bird-gallery-export') || document.body;
    let cleanup = null;
    let count = 0;

    const roots = [document.documentElement, target];
    roots.forEach(el => el && el.classList.add('exporting'));
    try {
        // ① 优先准备"全站图片"导出块
        if (typeof window.yeluPrepareFullExport === 'function') {
            const prepared = await window.yeluPrepareFullExport();
            if (prepared && prepared.element) {
                target = prepared.element;
                cleanup = prepared.cleanup || null;
                count = prepared.count || 0;
                target.classList.add('exporting');
            }
        }

        // ② 等所有图片解码完（全站 200 张，给足时间；超时也放行）
        await waitForImages(target, 20000);

        // ③ 按 canvas 上限挑缩放：手机 Safari 单画布约 16.7M 像素、单边 4096~8192，
        //    超了就是空白图，所以宁可小一点也必须保证能生成
        const rect = target.getBoundingClientRect();
        const scale = pickExportScale(rect.width, rect.height);

        const now = new Date();
        const stamp = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`
            + `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

        const dataUrl = await convertHtmlToJpg(target, {
            scale,
            excludeClasses: ['no-export', 'footer', 'header'],
            exportOnlyClasses: ['.export-only'],  // 仅导出时显示的类
            screenOnlyClasses: ['.screen-only']   // 仅屏幕显示的类
        });

        downloadPng(dataUrl, `夜鹭页录_全站${count ? count + '张' : ''}_v${stamp}.jpg`);

        return {
            dataUrl,
            count,
            scale,
            width: Math.round(rect.width * scale),
            height: Math.round(rect.height * scale)
        };
    } finally {
        if (cleanup) cleanup();
        roots.forEach(el => el && el.classList.remove('exporting'));
    }
}

/** 在手机/桌面 canvas 尺寸上限内挑一个尽量清晰的缩放比 */
function pickExportScale(width, height) {
    const MAX_AREA = 12e6;      // 留出安全余量：16.7M 是 iOS 的硬上限，html2canvas 内部还要翻倍占用
    const MAX_DIM = 8000;       // 单边上限
    const w = Math.max(1, width);
    const h = Math.max(1, height);

    let scale = Math.min(1.5, Math.sqrt(MAX_AREA / (w * h)), MAX_DIM / Math.max(w, h));
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    return Math.max(0.6, Math.min(1.5, Number(scale.toFixed(2))));
}

/** 等容器里的图片都加载完（带超时兜底） */
function waitForImages(container, timeoutMs = 5000) {
    const pending = Array.from(container.querySelectorAll('img'))
        .filter(img => !img.complete)
        .map(img => new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        }));

    if (!pending.length) return Promise.resolve();
    return Promise.race([
        Promise.all(pending),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
}

// 暴露给页面脚本（抽卡弹窗里的"导出长图"按钮）
window.yeluExportLongImage = exportLongImage;

document.addEventListener('DOMContentLoaded', function() {
    // 关于模态框相关事件（保持不变）
    const aboutBtn = document.getElementById('about-btn');
    const closeAboutModal = document.getElementById('close-about-modal');
    const closeAboutBtn = document.getElementById('close-about-btn');
    const aboutModal = document.getElementById('about-modal');
    const aboutModalContent = document.getElementById('about-modal-content');

    if (aboutBtn && aboutModal && aboutModalContent) {
        aboutBtn.addEventListener('click', function() {
            aboutModal.classList.remove('hidden');
            setTimeout(() => {
                aboutModalContent.classList.remove('scale-95', 'opacity-0');
                aboutModalContent.classList.add('scale-100', 'opacity-100');
            }, 10);
        });

        function closeModal() {
            aboutModalContent.classList.remove('scale-100', 'opacity-100');
            aboutModalContent.classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                aboutModal.classList.add('hidden');
            }, 300);
        }

        if (closeAboutModal) closeAboutModal.addEventListener('click', closeModal);
        if (closeAboutBtn) closeAboutBtn.addEventListener('click', closeModal);

        // 点击模态框外部关闭
        aboutModal.addEventListener('click', function(e) {
            if (e.target === aboutModal) {
                closeModal();
            }
        });
    }

    // 页脚"导出图片"按钮：已从页面移除（导出改成抽卡"终极"大奖）。
    // 这里保留兼容分支，万一以后又把按钮加回来，点了仍然能导出。
    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async function() {
            try {
                await exportLongImage();
                showNotification('图片导出成功！', 'success');
            } catch (error) {
                showNotification('导出失败: ' + error.message, 'error');
            }
        });
    }
});