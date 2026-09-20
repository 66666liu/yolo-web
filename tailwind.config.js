/** @type {import('tailwindcss').Config} */
module.exports = {
    // 页面全部代码都在 public/index.html 里（含内联 <script>），所以扫 .html 就够。
    // 如果以后往 public/ 加了新的业务 .html/.js，记得同步 scripts/check-tailwind.js。
    content: [
        "./public/**/*.html",
        // live2d-vendor 是第三方库，扫它会从一堆业务无关的字符串里
        // 生成出一批没人用的类名塞进 output.css
        "!./public/live2d-vendor/**",
    ],
    theme: {
        extend: {
            colors: {
                primary: '#111111',
                secondary: '#303030',
                neutral: '#e5e7eb',
                dark: '#212529'
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
            },
        }
    },
    plugins: [],
    corePlugins: {
        preflight: true, // 确保包含基础样式
    },
    future: {
        hoverOnlyWhenSupported: true, // 仅在支持hover的设备上应用hover效果
    }
}