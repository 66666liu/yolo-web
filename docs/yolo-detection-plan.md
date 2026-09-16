# 夜鹭页录 · YOLO 夜鹭检测闸门 接入方案

> 目标：把"上传时人工审核是否像夜鹭"这一步换成 YOLO 单类检测。
> 检出夜鹭 → 直接通过；未检出 → 提示"未检出夜鹭，夜师傅今天出什么COS~"，随后仍走原有上传流程。
> 改动范围：仅上传预览这一环 + 新增一个只读检测接口，其余逻辑不动。

## 0. 现状与锚点

| 事实 | 位置 |
|---|---|
| 上传表单：名称 + 图片 + 保存 | `public/index.html:152-179` |
| 选图后只做本地预览（无任何校验） | `public/index.html:830-841` `handleImageUpload` |
| 提交即落库，无审核态 | `public/index.html:851-907` → `server.js:335` `POST /api/birds` |
| multer 直接落盘、5MB 上限 | `server.js:38-51` |
| 写操作限流（现为"每 IP 每天 8 次上传额度"） | `server.js` `uploadQuotaGuard`（旧名 `operationRateLimiter`，已重写） |
| 操作日志（30 天） | `server.js:147-179` `logOperation` |
| 图片以文件名存于 `data.json`，静态托管于 `/api/images` | `server.js:26`、`server.js:352-356` |
| 现有 175 张带中文标签图 = 现成回归测试集 | `public/images/*.jpg` |

结论：`handleImageUpload` 是唯一的天然插入点（图片刚选好、还未上传，此时给提示最自然）。

## 1. 依赖

```bash
# 本机缓存目录在沙箱外会 EPERM，安装时显式指定项目内缓存
npm.cmd i --cache .npm-cache onnxruntime-node sharp
```

- `onnxruntime-node`：官方支持 Node 16+（推荐 20+），Windows x64 有 CPU 预编译二进制，当前 Node v24.19.0 可用。
- `sharp`：仅用于解码 + EXIF 旋转 + letterbox resize；sharp 缺失时检测接口返回 503，前端静默降级（不阻塞上传）。

`package.json` 新增脚本：

```json
"start": "node server.js",
"detect:probe": "node scripts/probe-model.js"
```

不要把 `models/*.onnx` 提交进 git（`data.json` 目前是提交的，模型另计），在 `.gitignore` 追加：

```
models/*.onnx
recognition_cache.json
.npm-cache/
```

## 2. 新增文件

```
models/
  yelu.onnx                  ← 你的单类 YOLO 模型
  detector.json              ← 新增：inputSize / conf / iou / classNames / letterbox 策略
recognition_cache.json       ← 运行时生成：{ "<sha1>": {found, score, boxes, at} }
detector.js                  ← 新增：模型加载 + 预处理 + YOLO 后处理 + 缓存
scripts/probe-model.js       ← 新增：探查 onnx 输入输出形状（先跑它确认后处理分支）
docs/yolo-detection-plan.md  ← 本文档
```

`models/detector.json` 建议形如：

```json
{
  "model": "yelu.onnx",
  "inputSize": 640,
  "letterbox": true,
  "confThreshold": 0.25,
  "iouThreshold": 0.45,
  "maxDetections": 20,
  "classNames": ["夜鹭"],
  "nightHeronClassIds": [0],
  "outputLayout": "auto"
}
```

单类模型 `nightHeronClassIds` 就是 `[0]`；闸门判定只看"是否存在该类的框且 score ≥ 阈值"，其余类别即使存在也不拦截。

## 3. `detector.js` 设计

对外只暴露三个函数：

```js
module.exports = { init, isReady, status, detect };            // detect(buffer) -> result
```

1. **懒加载单例**：`ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })`，首次调用时加载并 warmup 一次（用全零张量），加载失败只记录日志，不影响 `server.js` 正常启动。
2. **形状自适应，不硬编码**：从 `session.inputNames` / `session.outputNames` 取张量元信息，用 `inputSize` 与 `detector.json` 交叉校验，不一致时抛出可读错误（例如"模型输入为 1x3x640x640，配置写的是 416"）。
3. **预处理（适配 YOLO，必须 letterbox）**：`sharp(buffer).rotate()` 处理 EXIF → 等比缩放到 640×640 并补边（114 灰边）→ `raw()` 取 RGB → `/255` → NCHW `Float32Array`。同时记录 `scale` 与 `padX/padY`，供后处理把框映射回原图坐标。
4. **后处理（覆盖三种常见导出布局）**：
   - `[1, 4+nc, 8400]`（ultralytics 原始输出）→ 转置后按列取候选；
   - `[1, 8400, 4+nc]` 已转置；
   - `[1, N, 6]`（`x1,y1,x2,y2,score,cls`，含 NMS 或 end-to-end 导出）→ 跳过 NMS 直接用。
   是否已做 NMS 通过检测框重叠度启发式判断，`outputLayout: "auto"` 走这条启发式，也可手动指定。
5. **置信度**：`score = obj_conf * cls_conf`（若输出无 objectness 则 `score = cls_conf`），低于 `confThreshold` 丢弃，再按类做 NMS（IoU 阈值 `iouThreshold`）。
6. **并发与超时**：信号量限制同时 2 个推理，单张 5s 超时；超时/异常返回 `{found:false, error:'timeout'}` 而不是抛到路由层。
7. **缓存**：以图片 Buffer 的 sha1 为键，读写 `recognition_cache.json`（原子写：先写 `.tmp` 再 `fs.rename`；内存里保留最近 500 条 LRU）。同一张图预检一次、提交后再查一次不会重复推理。
8. **`status()`**：返回 `{ready, inputSize, classNames, modelFile, cacheSize}`，供前端决定是否展示检测入口。

## 4. `server.js` 改动（最小面）

### 4.1 新增内存上传通道（3 行）

保留现有 multer `storage` 不动，新增：

```js
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});
```

### 4.2 新增轻量限流（不复用上传额度中间件）

上传额度中间件（当时的 `operationRateLimiter`，现已重写为 `server.js` 里的 `uploadQuotaGuard`）按 IP 统计每日上传次数，且会写 `ip_operations.json`。检测是只读、会被反复调用，**绝不能挂上去**，否则用户点两次就把当天上传额度吃掉。新增：

```js
const detectLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,                       // 20 次/分钟/IP
    standardHeaders: true,
    message: { error: '检测请求过于频繁，请稍后再试' }
});
```

### 4.3 新增两个接口

| 方法 | 路由 | 中间件 | 说明 |
|---|---|---|---|
| GET | `/api/detect/status` | 无 | 模型是否就绪、输入尺寸、类别、缓存条数 |
| POST | `/api/detect` | `detectLimiter`, `uploadMemory.single('image')` | 传入图片 Buffer，返回检测结果 |

`POST /api/detect` 响应：

```json
{
  "found": true,
  "score": 0.87,
  "pass": true,
  "verdict": "已检出夜鹭，直接通过",
  "boxes": [{ "x": 120, "y": 40, "w": 300, "h": 260, "score": 0.87, "cls": 0 }],
  "image": { "width": 800, "height": 600 },
  "cached": false
}
```

未检出时：

```json
{
  "found": false,
  "pass": false,
  "verdict": "未检出夜鹭，夜师傅今天出什么COS~",
  "boxes": []
}
```

**闸门判定表（前后端用同一份规则，前端只渲染不做判断）**：

| 情况 | `found` | `pass` | 提示 |
|---|---|---|---|
| 检出夜鹭 | true | true | 已检出夜鹭，直接通过（绿色） |
| 未检出任何目标 | false | false | 未检出夜鹭，夜师傅今天出什么COS~（黄色，附"继续上传"） |
| 模型未就绪 / 异常 | false | true | 检测服务暂不可用，已跳过检测（灰色，静默放行） |

第三种是关键：**闸门永不阻塞上传**，模型挂了也照常能用。

### 4.4 原接口保持原样

`POST /api/birds` 一行不改。检测是"事前提示"而非"事前审批"，因此不需要 pending 状态、不需要审核队列、不需要动 `data.json` 结构。

## 5. `public/index.html` 改动

1. **新增 `checkImageDetection(file)` 工具函数**（放在 `handleImageUpload` 附近）：`FormData` 装 `image` → `POST ${API_BASE_URL}/detect` → 返回结果；异常时返回 `{pass:true, available:false}` 静默放行。
2. **改 `handleImageUpload`（`index.html:830-841`）**：本地预览照旧，预览下方插入检测状态行。
3. **新增检测状态行 DOM**（插在 `index.html:168-173` 的 `#image-preview-container` 内，`#image-preview` 之后）：
   - `.no-export` 类**必须加**，否则会污染 `html-to-png.js` 的长图导出；
   - 三态：检测中（spinner）/ 通过（绿 + score）/ 未检出（黄 + verdict + "仍要继续上传"按钮 + "重新选图"按钮）。
4. **提交不受影响**：`handleBirdFormSubmit` 不改逻辑，未检出时用户点"仍要继续上传"后正常提交，走原有 `POST /api/birds`、原有每日上传额度、原有日志。
5. **检测框可视化（可选，强烈建议做）**：把返回的 `boxes` 按 `预览图显示尺寸 / 原图尺寸` 的比例，绝对定位成一个黑色描边矩形盖在 `#image-preview` 上。这是最直观的"模型真的在看图"的证据，也能立刻暴露后处理坐标映射的 bug（框错位 = letterbox 反算错了）。
6. 识别结果**不入库**，因此刷新页面后徽章消失 —— 这符合"仅提示、不改动其他"的约束。若后续想持久化，再加 `recognition_cache.json` 与 `/api/birds` 的合并即可（本次不做）。

## 6. 实施顺序

1. `npm.cmd i --cache .npm-cache onnxruntime-node sharp`；`node -e "require('onnxruntime-node');require('sharp')"` 验证原生二进制可加载。
2. 写 `scripts/probe-model.js`，打出模型的输入输出名字/形状/dtype，据此确认后处理分支与 `inputSize`。
3. 写 `models/detector.json` + `detector.js`；加 `GET /api/detect/status`、`POST /api/detect`。
4. **回归验证（关键一步）**：用仓库自己已有的图当测试集跑 CLI 批测 ——
   - 正样本：`public/images/夜鹭.jpg`、`夜鹭-2.jpg` … `夜鹭-16.jpg`（应 `found:true`）；
   - 负样本：`海鸥.jpg`、`企鹅.jpg`、`路灯.jpg`、`保龄球.jpg`（应 `found:false`）。
   注意站点主题决定了**负样本才是大多数**，误报率比漏报率更影响体验（误报会让恶搞图上不出现提示，漏报只是多一句"夜师傅"）。
5. 前端：`checkImageDetection` + 状态行 + 框可视化。
6. 端到端手测：选夜鹭图 → 绿字直接通过 → 保存成功；选路灯图 → 黄字"夜师傅今天出什么COS~" → 点继续 → 保存成功；停掉模型文件 → 灰字静默放行。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型缺失 / 加载失败导致检测不可用 | `pass:true` 静默放行，绝不阻塞上传（降级路径第 3 条） |
| 前端逐次选图重复推理刷 CPU | 后端按 Buffer sha1 缓存 + 前端 20 次/分钟限流；上传后同图命中缓存 |
| letterbox 坐标映射错误 → 框画歪 | 批测时肉眼比对框；先把框可视化做出来再谈美化 |
| 小图/长图/透明 PNG 输入导致解码异常 | `sharp` 统一 `flatten` 白底 + `rotate()` + `toColorspace('srgb')`，异常归入静默放行 |
| 同一张图预检与提交时各推理一次 | 缓存按内容 sha1，非文件名 |
| 未来多进程部署时 `recognition_cache.json` 并发写 | 原子写（`.tmp` + rename）；或换成内存缓存 + 定时落盘 |
| 上线后服务器 glibc 过旧、原生二进制不可用 | 部署前在服务器上先跑第 1 步的 `require` 验证；不可用则改走浏览器端 onnxruntime-web（本次不实现） |
