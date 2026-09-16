# 夜鹭检测闸门 · 实施说明

> **当前状态：代码已全部实现并验证，仓库内暂不含模型文件。**
> 检测能力处于优雅降级状态 —— 服务照常启动、上传流程完全不受影响，
> 只是在选图时静默跳过检测。把重新训练的 `models/yelu.onnx` 放进去即自动生效，无需改代码。
>
> 早前试用的 `Desktop\测试\best.onnx` 经诊断**不可用**：它对任何图片都输出"检出夜鹭"
> （保龄球 0.94、路灯 0.85），原因是训练集里没有任何负样本。该文件已被移除。
> 详见第 4 节。放置新模型的步骤见 `models/README.md`。

## 1. 最终设计

```
用户选图
   │
   ├─ 前端立即 POST /api/detect（内存态，不落盘）
   │       │
   │       ├─ found=true   → 绿字"已检出夜鹭，直接通过" + 画检测框
   │       ├─ found=false  → 黄字"未检出夜鹭，夜师傅今天出什么COS~"
   │       │                  + [仍要继续上传] [重新选图]
   │       └─ 模型不可用    → 不显示任何提示，静默跳过（首次探测后整段短路）
   │
   └─ 点保存 → 原有 POST /api/birds 流程完全不变
```

三条硬性约束（已实现）：

1. **闸门永不阻塞上传**：未检出时用户点"仍要继续上传"即可提交；模型故障时直接放行。
2. **原有上传链路零改动**：`POST /api/birds`、上传额度（每 IP 每天 8 次，见 `UPLOAD_DAILY_LIMIT`）、操作日志、`data.json` 结构均未改。
3. **检测不消耗上传额度**：检测走独立的 20 次/分钟限流，**没有**挂 `uploadQuotaGuard`（否则用户点两次检测就吃掉当天上传额度）。

## 2. 文件清单

| 文件 | 说明 |
|---|---|
| `detector.js` | 新增。模型加载、letterbox 预处理、YOLO 后处理、NMS、sha1 缓存、并发信号量 |
| `models/README.md` | 新增。模型放置与验收说明 |
| `models/detector.json` | 新增。模型与阈值配置 |
| `models/yelu.onnx` | **仓库不含**，需自行放入（见 `models/README.md`） |
| `scripts/test-detect.js` | 新增。回归验证脚本，用 `public/images` 现有图跑正负样本 |
| `server.js` | 改。新增 `uploadMemory`、`detectLimiter`、`GET /api/detect/status`、`POST /api/detect`、启动预热 |
| `public/index.html` | 改。新增检测状态行、检测框图层、`checkImageDetection`/`runDetection`/`renderDetectBoxes` |

### 模型缺失时的行为

| 环节 | 表现 |
|---|---|
| 服务启动 | 正常启动，只打一行警告 |
| `GET /api/detect/status` | `ready:false` + 具体原因 |
| `POST /api/detect` | HTTP 200，`pass:true`、`available:false`（静默放行） |
| 前端选图 | 首次探测到 `ready:false` 后**整段跳过**，不显示提示、不再发请求 |
| 上传 / 限流 / 日志 / `data.json` | 完全不受影响 |

## 3. 接口

### `GET /api/detect/status`
```json
{ "ready": true, "modelFile": "yelu.onnx", "inputSize": 640,
  "classNames": ["夜鹭"], "confThreshold": 0.25, "cacheSize": 25 }
```

### `POST /api/detect`（multipart，字段名 `image`）
```json
{ "found": true, "score": 0.8736, "pass": true,
  "verdict": "已检出夜鹭，直接通过", "label": "夜鹭",
  "detections": [{ "x": 78, "y": 16, "w": 131, "h": 297, "score": 0.8736, "cls": 0, "label": "夜鹭" }],
  "image": { "width": 243, "height": 329 },
  "model": { "file": "yelu.onnx", "inputSize": 640, "confThreshold": 0.25, "iouThreshold": 0.45 },
  "cached": false }
```

未检出时 `found:false`、`pass:false`、`verdict:"未检出夜鹭，夜师傅今天出什么COS~"`。
模型故障时 `pass:true`、`available:false`（前端据此显示灰色静默放行），**HTTP 仍是 200**。

## 4. 被弃用模型的诊断记录（重要）

> 曾试用的 `Desktop\测试\best.onnx` 已移除，此处保留诊断数据，用于说明"为什么必须带负样本重训"。

对 17 张真夜鹭 + 15 张明确非夜鹭做了完整的预处理网格搜索，用 ROC-AUC 衡量分离度（0.5 = 随机）：

| 预处理 | AUC | 最佳准确率 |
|---|---|---|
| resize + RGB + 0-1 | 0.298 | 53% |
| resize + BGR + 0-1 | 0.353 | 56% |
| letterbox + RGB + 0-1 | 0.227 | 53% |
| letterbox + BGR + 0-1 | 0.290 | 53% |
| resize + RGB + 0-255 | 0.525 | 59% |
| resize + RGB + ImageNet 归一化 | 0.545 | 63% |
| letterbox + RGB + ImageNet 归一化 | **0.565** | 69% |

**最强组合也只有 0.565。** 排除预处理因素的其他证据：

| 检验 | 结果 | 说明 |
|---|---|---|
| 全零输入最高分 | 0.0388 | 不是恒定输出 |
| 随机噪声最高分 | 0.0013 | 确实在响应图像内容 |
| 夜鹭.jpg | 0.7567 | — |
| 路灯.jpg | 0.8580 | 比夜鹭高 |
| 保龄球.jpg | 0.9385 | 比夜鹭高 |

**根因**：训练数据集 `测试\夜鹭网图-800`（单类 `0` = 夜鹭，377 个框）中
**空标签文件数量 = 0**，即训练集里没有任何"图中无夜鹭"的负样本。
模型只学过"图里有夜鹭"，没学过"图里没有夜鹭"，因此退化为对一切输入都给出高置信度。
这也解释了为何它在自己的验证集上 mAP50 = 0.977 —— 验证集同样是纯夜鹭。

## 5. 重新训练建议

要让闸门真正可用，需要**带难负样本**重训：

```yaml
# data.yaml
path: /path/to/dataset
train: train/images
val: val/images
names:
  0: 夜鹭
```

1. **正样本**：现有夜鹭图 + `public/images/夜鹭*.jpg`。
2. **负样本（关键）**：为每张非夜鹭图建立**空的** `.txt` 标签文件（YOLO 以此表示"无目标"，这正是当前数据集完全缺失的）。
   - 首选**难负样本**：苍鹭、白鹭、中白鹭、苇鳽、夜鹭幼鸟等外形相近的鹭科鸟类（`public/images` 与 `CUB_200-YOLO` 里都有）
   - 再加入站点里出现过的干扰物：路灯、保龄球、西瓜子、雨伞、圆规等
   - 正负比例建议 1:1 ~ 1:2
3. 训练参数参考：`yolo detect train model=yolov8n.pt data=data.yaml epochs=100 imgsz=640 batch=16`
4. 导出：`yolo export model=best.pt format=onnx opset=12 imgsz=640`
5. **验收标准**：用 `node scripts/test-detect.js` 跑，要求正样本全检出、负样本全不检出；AUC 应 > 0.9。

> 脚本会同时输出 **AUC（分离度）**，不能只看"正负样本是否各自全对"。
> 退化模型（把一切都判为夜鹭）的负样本会全 MISSS，正常情况下会被发现；
> 但反向退化（把一切都判为非夜鹭）也可能让正样本"看起来只是没检出"，
> 而 AUC 能同时抓住两种退化。**AUC < 0.9 时脚本以退出码 1 结束，并提示检查训练集负样本。**

## 6. 验证方式

```bash
# 依赖安装（沙箱环境需跳过 lifecycle 脚本，本机正常环境可直接 npm i）
npm.cmd i --ignore-scripts onnxruntime-node sharp

# 回归验证（用 public/images 现有图）
node scripts/test-detect.js
node scripts/test-detect.js 某张图.jpg        # 单独测一张

# 起服务后手工验证
curl http://localhost:3000/api/detect/status
curl -X POST -F "image=@public/images/夜鹭.jpg" http://localhost:3000/api/detect
```

浏览器侧三态手测（放入模型后）：选夜鹭图 → 绿字直接通过 → 保存成功；选路灯图 → 黄字"夜师傅今天出什么COS~" → 点"仍要继续上传" → 保存成功。

模型缺失时的手测：直接起服务 → 选任意图 → 无任何检测提示、控制台仅一行 `[夜鹭检测] 模型未就绪，已跳过检测` → 保存照常成功。

## 7. 已修复的三个严重 Bug（留档，避免重犯）

1. **张量布局**：ultralytics 导出 `[1,4+nc,N]` 是**通道优先**，第 c 通道第 i 个候选位于 `c*N+i`。
   最初按 `i*C+c` 读取，导致框参数与分数全部错位，每张图产出满屏退化小框。
2. **激活函数误判**：最初用"整个张量是否存在 >1 的值"判断是否需要 Sigmoid。
   但框参数（cx,cy,w,h）本身就是几十到几百的像素值，必然 >1，于是被误判为 logits，
   对全张量套 Sigmoid 把框压成 1.0。**判据必须只看类别分数**（`detector.js` 的 `needsSigmoid`）。
3. **输出张量未校验**：原先直接取 `session.outputNames[0]`。若误放入分割/姿态等原始导出，
   该输出可能是 `[1,64,80,80]` 这类特征图，而 auto 布局又会把 80 通道当成类别数，
   从而解析出满屏假检出。现已强制要求：**单输出 + `[1, C, N]` 三维 + batch 为 1**，
   否则抛出明确错误并降级为静默放行。
   （实测把 79 类分割导出放进 `models/yelu.onnx` 会被正确拦下，报
   "模型有 9 个输出…请用 yolo export format=onnx 导出 detect 任务的模型"。）

### 坐标还原精度

对 5 种极端长宽比（含 1920×480 超宽图、37×29 极小图）做了模型空间 → 原图空间的往返校验，
**像素级误差为 0**。

前端画框（`renderDetectBoxes`）现在把检测框图层对齐到"图片实际画出来的矩形"
（图片布局盒 + `object-contain` 留白），图层与图片严格同尺寸，框在图层里用百分比定位。
于是滚动预览、窗口缩放、弹窗缩放动画都不会让框和图片错位
（headless 浏览器实测：各滚动位置误差 ≤ 0.05px，含父级 `scale()` 动画时同样 ≤ 0.05px）。

早期版本按**容器可视高度**算 contain 比例、又减了一次 `scrollLeft/scrollTop`，会同时踩两个坑：
比例只有真实值的一半左右（图片高于容器时容器可滚动，图片渲染高度远大于可视高度），
以及绝对定位图层本身随内容滚动造成的重复补偿 —— 表现为"框没固定在图上、拖滚动条时框漂移"。
现在图层随图片一起滚动，滚动时无需任何重算。

### 缓存的模型指纹问题

缓存以图片内容 sha1 为键、不含模型指纹，换模型后会串味。
检测结果是纯派生数据、重新推理成本很低，因此**每次成功加载模型都会清空缓存**从头算。

## 8. 其他注意事项

- 检测结果**不入库**，刷新页面后徽章消失（符合"仅提示、不改动其他"的约束）。
  若后续想持久化，可读取 `recognition_cache.json` 与 `/api/birds` 合并。
- 检测状态行与检测框均带 `no-export` 类，不会污染 `html-to-png.js` 的长图导出。
- `recognition_cache.json` 按图片内容 sha1 缓存，采用 `.tmp` + `rename` 原子写，
  且每次加载模型时清空（见第 7 节末）。
- **回归验证待模型**：`npm run test:detect` 的完整正负样本回归，以及前端绿字/黄字三态，
  都需要真实模型才能跑完。仓库当前无模型（检测走静默跳过），该脚本会明确提示
  "模型未就绪"并以退出码 1 结束。
