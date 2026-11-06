# Task 30 — S1/S2/S3 与手绘稿视觉对照

> 历史设计/验收笔记：部分证据链接指向私有开发存档 `.omo/`，该目录不在本仓库中。


- **日期**：2026-11-05
- **结论**：**PASS**
- **未批准偏差**：**0**
- **采集环境**：1920×1080、DPR 1、X11 `:0`（KWin composited，spectacle `-b -n -f`）；真实桌面背景（壁纸 + Chrome/OpenCode 窗口），不是纯色假背景。
- **原稿**：`docs/design-sketch.jpeg`（SHA-256 `e7dcb5c7f74e924f99e942faa2b04d1c01b13d6ee2fbb9373f076d721298545d`，mtime 2026-11-05 11:45:35；未修改）。对照使用 960×540 降采样副本 `.omo/evidence/m1/sketch-downscaled.png`。
- **主证据**：`.omo/evidence/m1/s1.png`、`s2.png`、`s3.png`、`settings.png`、`onboarding.png`；错误/空态 `error.png`、`history-empty.png`；细节裁切 `.omo/evidence/m1/visual-details/`（8 张 @2x + `crops.json`）。
- **重要限制**：本机 KWin Blur effect 为 **OFF**。本报告**不声称模糊工作**；实机卡片是真实的 `rgba(24,26,28,0.72)` 透明 alpha，无 `backdrop-filter` 伪造，属于诚实降级（NFR-07 `PASS (degraded)`）。

---

## 1. 并排对照

![S1 并排](../.omo/evidence/m1/compare-s1.png)

| 状态 | 手绘稿 | 实机 | 并排证据 | 结论 |
|---|---|---|---|---|
| S1 输入态 | 单条胶囊：时钟（历史）→ 下箭头（展开）→ 加号（新建）→ 分隔线 → 输入 → 圆形发送；旁注“向侧边历史对话”“向底边展开对话”“进入新的会话” | 680×48 条，屏幕 `620,130`；三按钮顺序一致；分隔线 1×20；36×36 圆形发送；含 Q3 批准的“带入剪贴板”内联 chip | `.omo/evidence/m1/compare-s1.png` | **PASS** |
| S2 对话态 | 手绘旁注“向底边展开对话”；面板从条下方展开，条不动 | 面板 680×420 位于条下方，gap 12（条底 178，面板顶 190）；条仍在 `620,130`；面板内**无输入框** | `.omo/evidence/m1/compare-s2.png` | **PASS** |
| S3 历史态 | 手绘旁注“向侧边历史对话”；历史栏在左侧、与条对齐 | 历史栏 260×480 位于 `348,130`，与条顶 `130` 对齐，gap 12；当前会话 2px 主色标记；条仍在 `620,130` | `.omo/evidence/m1/compare-s3.png` | **PASS** |

![S2 并排](../.omo/evidence/m1/compare-s2.png)

![S3 并排](../.omo/evidence/m1/compare-s3.png)

> 手绘稿只画了条与方向旁注，面板/历史栏内部细节由 `REQUIREMENTS.md` §3.3–§3.6/§3.10 补全；实机按规格实现。五状态拼图见 `.omo/evidence/m1/task30-verify-sheet.png`。

---

## 2. Checklist（结构/几何）

| ID | 检查项 | 要求 | 实测 | 结果 | 证据 |
|---|---|---|---|---|---|
| C1 | S1 三按钮顺序 | 历史 → 展开 → 新建 | DOM `childOrder = [btn-history, btn-expand, btn-new, bar-divider, composer, btn-send]`；裁切可见时钟→下箭头→加号 | **PASS** | `tests/visual/layout.spec.ts`（S1 断言）；`visual-details/bar-left.png` |
| C2 | 分隔线 | 1×20，左右各 8 | `divider.width=1`, `height=20`, margins `8px/8px`；位于“新建”后 8px | **PASS** | 同上；`task-14-tokens.json` computed.divider |
| C3 | 发送按钮 | 36×36 圆形，图标 16，空输入 35% 禁用 | `send=36×36`, `borderRadius=50%`, icon 16；空输入 `opacity=0.35`；有内容时主色实心/深色图标 | **PASS** | `layout.spec.ts`；`visual-details/bar-right.png` |
| C4 | 条尺寸/圆角 | 680×48，r24 | 视觉条 `680×48 r24`；屏幕 `620,130`；OS 窗 `760×128`（Q3 gutter 40/28/40/52） | **PASS** | `task-14-tokens.json`；`task-12-anchor.json`；`s1.png` |
| C5 | 条→面板间距 | 12 | 条底 `178`，面板顶 `190`；`gapBarPanel=12` | **PASS** | `layout.spec.ts`；`visual-capture.json` states.s2 |
| C6 | 面板内无输入 | 输入只在顶部条 | `hasInputInsidePanel=0`；S2/S3 截图底部无输入框 | **PASS** | `tests/visual/layout.spec.ts`；`s2.png`/`s3.png` |
| C7 | 历史栏位置/对齐 | 左 260，gap 12，与条顶对齐 | 侧栏 `348,130 260×480`；`348 = 620 − 12 − 260`；顶边同为 `130` | **PASS** | `visual-capture.json` states.s3；`layout.spec.ts` S3 |
| C8 | 历史项高度 | 48，圆角 8，左内边距 10 | `item.height=48`, `radius=8px`, `padding-left=10px`；`task-20-history.json itemHeight=48` | **PASS** | `layout.spec.ts`；`task-20-history.json` |
| C9 | 当前会话标记 | 左 2px 主色竖条 + 0.08 背景 | `markerWidth=2px`，`rgb(127,187,179)`；`current` 背景 `rgba(255,255,255,0.08)`；仅 1 个 current | **PASS** | `layout.spec.ts`；`visual-details/sidebar-current-item.png` |
| C10 | S4 设置窗 | 720×560，系统标题栏 | `contentSize [720,560]`；`frame:true`（系统标题栏）；`settings.png` 可见 KWin 标题栏 | **PASS** | `task-22-s4.json`；`src/main/window/manager.ts`；`settings.png` |
| C11 | 托盘菜单 | 5 项；左键 toggle/右键菜单（Q4） | `显示/隐藏（动态）`、`新建会话`、`历史`、`设置`、`退出`；左键两次 activate → S1/S0；SNI tooltip `QuickAsk` | **PASS** | `task-13-tray.json`；`task-13-summary.json`；`task-6-tray-summary.json` |
| C12 | 条锚点稳定 | S1/S2/S3 均为 `620,130` | `task-12-anchor.json` 三态一致；NFR-02 动画期间 `barDriftPx` p95=0 | **PASS** | `task-12-anchor.json`；`nfr02.json` |
| C13 | 条在最上层 | 动画中不被遮挡 | xprop `_NET_WM_STATE_ABOVE, _NET_WM_STATE_STAYS_ON_TOP`；窗口 active | **PASS** | `task-12-xprop.txt`；`visual-capture.json` |
| C14 | 面板/侧栏动画 | 160ms、`cubic-bezier(0.2,0,0,1)`、条不动 | S2 P95 158.8ms，S3 P95 158.8ms；`barDriftPx p95=0`；reduced-motion 0ms/无动画 | **PASS** | `nfr02.json`；`nfr02-frames.json` |

---

## 3. Token 核对

### 3.1 几何与间距

| Token | 规格 | 实测 | 结果 | 证据 |
|---|---|---|---|---|
| `W` | 680（可调 560–900） | 680px；`--bar-w` 680 | **PASS** | `task-14-tokens.json` geometryTokens |
| `BAR_H` / `R_BAR` | 48 / 24 | 48px / 24px | **PASS** | 同上 |
| `R_CARD` | 16 | 16px（面板/侧栏） | **PASS** | 同上；`nfr05-pixels.json` |
| `GAP` | 12 | 条→面板 12；侧栏→条 12 | **PASS** | `layout.spec.ts`；geometry 单测 |
| `SIDEBAR_W` | 260 | 260 | **PASS** | `layout.spec.ts`；`task-20-history.json` |
| `PAD` | 16 | 16px | **PASS** | `layout.spec.ts` |
| `ICON_BTN` | 32×32 / icon 18 | 32 / 18 | **PASS** | `task-14-tokens.json` computed.iconButton |
| `SEND_BTN` | 36×36 / icon 16 | 36 / 16 | **PASS** | 同上 |
| 输入区最小宽 | 240 | `min-width:240px`；680 条 + Q3 chip 下仍 ≥240（按布局约 245px） | **PASS** | `layout.spec.ts`；`clipboard-chip` CSS |
| 间距阶梯 | 2/4/8/12/16/24 | 仅这些值 | **PASS** | `task-14-tokens.json` spacing |
| 面板高 | 120–560，内部滚动 | 空态 120；S2/S3 420；fixed-H + 内部滚动为 Q3 | **PASS** | `task-19-summary.json`；`visual-capture.json`；`s2.png` |

### 3.2 字体、颜色、CJK

| 项 | 规格 | 实测 | 结果 | 证据 |
|---|---|---|---|---|
| UI 字体 | 系统 sans（Noto Sans CJK SC） | `'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', sans-serif`；`fontCheck=true` | **PASS** | `task-14-tokens.json`；`task-14-network.json` |
| 等宽字体 | 霞鹜文楷等宽 / LXGW WenKai Mono | mono stack 含 `LXGW WenKai Mono`；代码块 computed 匹配 | **PASS** | `layout.spec.ts`；`task-14-tokens.json` |
| 远程字体 | 禁止 | `fontFaceRules=[]`、`externalStylesheets=[]`；网络仅 `file:`，`externalRequests=[]` | **PASS** | `task-14-network.json` |
| 字号 | 正文 14 / 输入 15 / 标题 13–14 / 辅助 11–12 / 代码 13 | 全部匹配（panel title 13、model 12、item time 11、composer 15、assistant 14/23.8） | **PASS** | `task-14-tokens.json`；`layout.spec.ts` |
| 暗色颜色 | 卡片 `rgba(24,26,28,0.72)`、描边 `rgba(255,255,255,0.10)`、正文 .92/次要 .62/弱化 .40 | 全匹配；截图即为 72% alpha | **PASS** | `task-14-tokens.json`；`task-23-opacity.json` |
| 亮色颜色 | `rgba(250,250,248,0.78)`、`rgba(0,0,0,0.08)`、正文 .88/.60/.42 | 匹配（Task 23 亮色切换证据） | **PASS** | `task-14-tokens.json`；`task-23-appearance.json` |
| 主色 | 默认 `#7fbbb3`，6 色可选 | `#7fbbb3`（Everforest）；6 色齐全 | **PASS** | `task-14-tokens.json`；`task-23-appearance.json` |
| CJK 字形 | 不裁切、无 tofu、无错误换行 | 裁切图显示完整；`fontCheck=true`、CJK 样本宽 84；见 §5.1 | **PASS** | `visual-details/*.png`；`task-14-tokens.json` |

### 3.3 阴影、gutter、动效

| 项 | 规格/要求 | 实测 | 结果 | 证据 |
|---|---|---|---|---|
| 卡片阴影 | `0 12px 40px rgba(0,0,0,0.45)`（暗） | computed `0px 12px 40px` + inset；真实 PNG 有 shadow alpha | **PASS** | `layout.spec.ts`；`nfr05-pixels.json` |
| 透明 gutter | Q3 例外，阴影不被裁 | gutter `top/left/right/bottom = 28/40/40/52`；`gutter_ok=true` | **PASS（Q3）** | `nfr05-pixels.json`；`nfr05-summary.json` |
| 圆角 alpha | 无黑角/无实心角 | 半径内 alpha 14.5–61.75（阴影），中心 184–209；`rounded_corner=true` | **PASS** | `nfr05-pixels.json`；`card-corners.png` |
| 面板动画 | 160ms，`cubic-bezier(0.2,0,0,1)` | `computedAnimationDuration=0.16s`；S2/S3 animationStart→End P95 158.8ms | **PASS** | `nfr02.json` |
| 动画期间条 | 不位移/不缩放/不淡入 | `barDriftPx p95=0`；窗口 left/top 同步扩展 | **PASS** | `nfr02.json`；`task-12-anchor.json` |
| 减少动态 | 直接切换，无过渡 | reduced-motion 0ms、`animationName=none`、`intermediateCount=0` | **PASS** | `nfr02.json`（reducedMotion） |

---

## 4. 偏差清单（what / why / approved?）

> 只有 Q3/M1 已批准的例外；**未批准偏差 = 0**。

| ID | What（观察到的差异） | Why（原因/范围） | Approved? | 证据 |
|---|---|---|---|---|
| D1 | 窗口四周保留不可见透明 gutter（40/28/40/52），视觉条仍是 680×48 | 让 `0 12px 40px` 阴影/圆角不被 OS 窗口裁切；Q3 视觉例外包“asymmetric gutter/shadow” | **YES — Q3** | `nfr05-pixels.json`；`task-12-anchor.json` |
| D2 | S1 条内多出“带入剪贴板 …”胶囊（手绘稿未画） | F-09 剪贴板 hint 不占第二行、不抢输入框；Q3 “inline clipboard chip” | **YES — Q3** | `s1.png`；`visual-details/bar-left.png`；`task-18-clipboard.json` |
| D3 | 首次引导放在 S4 设置窗内（手绘稿只画条） | 无 provider 时主窗保持 S0/禁用发送；Q3 “onboarding in S4” | **YES — Q3** | `onboarding.png`；`task-22-onboarding.json` |
| D4 | 面板固定高度 + 内部滚动（非按内容无限增长） | 锚点/窗口几何/ShapeInput 可锁定；Q3 “fixed panel H/internal scroll” | **YES — Q3** | `s2.png`/`s3.png`；`visual-capture.json`；`task-20-history.json` |
| D5 | M1 设置只实现“模型/外观”；快捷键/行为/数据/关于显示为“即将支持” | M1 范围（设置即时生效，不含 M2 功能）；Q3/M1 “settings only model/appearance” | **YES — Q3/M1** | `settings.png`；`task-22-s4.json` navText |
| D6 | 托盘左键 toggle、右键菜单；不是“点击托盘图标直接弹设置” | Q4 托盘语义（F-01.4 五项保留，放弃双击） | **YES — Q4** | `task-13-tray.json`；`task-13-summary.json` |

**未批准偏差：无。** 因此无需最小修复/重拍，也没有把任何一项标为 FAIL。

### 4.1 观察到但不构成 §3 偏差的事项（透明记录）

- **发送图标方向**：手绘稿用向右箭头示意“发送”；实机使用规范图标集中的向上箭头（`IconSend`）。§3.4 只约束 36×36 圆形/16px 图标/深色图标，不约束箭头方向；不属于规格偏差。
- **合成数据标题**：S2 面板标题由首条用户消息派生（`问题 1：多个写入同时发生时 SQLit`，20 字），S3 侧栏显示 seed DB 的会话标签（`代理环境下证书校验 #1000`）。这是合成 seed 数据的人为差异；真实新建会话两者都来自首条消息，不是 UI 缺陷。
- **真实桌面背景**：s1/s2/s3 背后的 Chrome/终端/壁纸是真实桌面，且透过 72% alpha 可见；这是任务要求的“真实背景”，不是假背景，也不是黑底。
- **S2 真实会话无 fenced code block**：`visual-details/code-block.png` 实际裁的是助手文本气泡（`crops.json` 已注明）。代码块/表格视觉由 `task-14-s2.png` 与 `task-19-verify.png` 的窗口级证据覆盖。
- **错误/空态来源**：`error.png` 是 Task 30 现场真实桌面 429 复拍，语义对齐 `task-19-error-429.json`（`限流，稍后再试（不自动重试） · mock rate limit`）；`history-empty.png` 是 Task 30 现场真实桌面 S3 搜索空态复拍（query `nowhere-xyz`），语义对齐 `task-20-search.json`（`emptyText: 没有匹配的会话`）。两者均为真实状态；`history-empty.png` 同时保留了同一会话的 429 错误条，未做拼接。

---

## 5. 视觉细节评审（基于真实截图/裁切）

### 5.1 CJK 不裁切

| 观察 | 证据 | 结论 |
|---|---|---|
| “带入剪贴板”、历史时钟/展开/新建、placeholder 完整，无 tofu/裁切 | `visual-details/bar-left.png` | **PASS** |
| 用户气泡“问题 7：… 参考编号 QA-1000-7。”跨两行，字形完整；长 token `QA-1000-7` 在连字符处换行，无单字孤行 | `visual-details/user-bubble.png` | **PASS** |
| 侧栏当前项“代理环境下证书校验 #1000”完整，时间 `01-02` 右对齐；长标题省略号 | `visual-details/sidebar-current-item.png` | **PASS** |
| 设置/引导中文标签（模型/外观/快捷键/即将支持/首次设置/base_url/超时…）完整，无裁切 | `settings.png`；`onboarding.png` | **PASS** |
| 429 错误条“限流，稍后再试（不自动重试）· mock rate limit / 重试”完整 | `error.png`；`task-19-error-429.json` | **PASS** |
| 搜索空态“没有匹配的会话”居中完整 | `history-empty.png`；`task-20-search.json` | **PASS** |

### 5.2 圆角无黑边 / 阴影不被裁

| 检查 | 观察 | 证据 | 结论 |
|---|---|---|---|
| 条四角 | 圆角外侧透出真实桌面/壁纸，无黑色实心角；`corner_alpha` 14.5（阴影）、中心 209 | `visual-details/bar-card-corners.png`；`nfr05-pixels.json` | **PASS** |
| 面板/侧栏四角 | 圆角外侧透出桌面，无黑角；panel corner alpha 38.25、sidebar 17.5；`rounded_corner=true` | `visual-details/card-corners.png`；`nfr05-pixels.json` | **PASS** |
| 面板底边阴影 | 阴影落在 Q3 的 52px 底部 gutter 内，未被窗口裁切；`shadow_present=true` | `visual-details/shadow-bottom.png`；`nfr05-pixels.json` | **PASS** |
| 1px 内描边 | `rgba(255,255,255,0.10)` 规格内描边，不是模糊白框 | `layout.spec.ts`；`visual-details/bar-card-corners.png` | **PASS** |

### 5.3 Blur（诚实不可用，不伪造）

- 现场 KWin **Blur effect OFF**：`nfr07-summary.json` → `blur_available=false`、`blur_effect_enabled=false`、`honest_degrade=true`；`task-23-blur.json` → `backdropFilterMatches=[]`、xprop `_KDE_NET_WM_BLUR_BEHIND_REGION: not found`、状态文案“KWin 模糊效果未开启…当前不会伪造模糊”。
- 截图中的透明效果来自真实卡片 alpha（72%），**不是模糊**；没有白色 glow/白框。**不声称 blur 工作**。
- 结论：**PASS（degraded）** — 行为诚实，NFR-07 已记录为 PASS (degraded)。

### 5.4 点击穿透（Task 12）

- `task-12-clickthrough.log`：点击条/面板之间 12px 透明间隙中心 `960,184`，`renderer_clicks_before=0`、`renderer_clicks_after=0`，下层 `xev` 收到 `ButtonPress`/`ButtonRelease`；`xev_buttonpress=true`。
- `task-12-shape.txt`：S3 `INPUT_SHAPE=5`，gutter/间隙不在 input shape；`task-12-xprop.txt`：窗口 `ABOVE/STAYS_ON_TOP`、skip atoms 齐全。
- 结论：**PASS**。

### 5.5 面板无输入 / 条不位移

- `hasInputInsidePanel=0`（`tests/visual/layout.spec.ts`）；S2/S3 截图底部只有面板内容，无输入框。
- bar 屏幕坐标 S1/S2/S3 均 `620,130`；NFR-02 动画期间 drift p95=0。
- 结论：**PASS**。

### 5.6 设置 / 引导 / 错误 / 空态

| 状态 | 实机观察 | 证据 | 结论 |
|---|---|---|---|
| S4 设置（模型） | 720×560 内容，KWin 系统标题栏；左导航 6 项；模型表单；底部“关闭”；快捷键/行为/数据/关于“即将支持”（M1 范围） | `settings.png`；`task-22-s4.json` | **PASS** |
| S4 首次引导 | 主窗 S0、composer 禁用；S4 内显示“首次设置”；测试前 0 请求 | `onboarding.png`；`task-22-onboarding.json` | **PASS（Q3）** |
| 429 错误 | 底部红系错误条 + 左图标 + 文案 + 右“重试”；文案可见 | `error.png`；`task-19-error-429.json` | **PASS** |
| 历史搜索空态 | “没有匹配的会话”可见；侧栏仍为 260×480 | `history-empty.png`；`task-20-search.json` | **PASS** |

---

## 6. 回归与测试证据

- 全量单测：`31 files / 289 tests passed`（`.omo/evidence/m1/history-1000-typecheck-build-test.log`、`.omo/evidence/m1/nfr-m1-unit.log`）。
- 全量 E2E：`88 passed (2.0m)`（`.omo/evidence/m1/nfr-m1-e2e.log`、`.omo/evidence/m1/task28-e2e.log`）。
- 视觉布局断言：`tests/visual/layout.spec.ts` 对上述 C1–C9 token 逐项断言（bar/sidebar/panel/无输入/字体/颜色）；动画由 `nfr02.json` 覆盖。
- 本任务**未改任何 UI 源码**（没有发现需要最小修复的真实视觉 bug），因此未重跑全量 E2E；只生成对照图和报告。`pgrep -x electron` 为空。

---

## 7. 证据索引

### 主图
- `.omo/evidence/m1/s1.png`、`s2.png`、`s3.png` — 1920×1080 真实桌面
- `.omo/evidence/m1/settings.png`、`onboarding.png` — S4
- `.omo/evidence/m1/error.png`、`history-empty.png` — 错误/空态
- `.omo/evidence/m1/compare-s1.png`、`compare-s2.png`、`compare-s3.png` — 并排
- `.omo/evidence/m1/sketch-downscaled.png` — 原稿降采样副本
- `.omo/evidence/m1/task30-verify-sheet.png` — 5 状态拼图

### 细节裁切（@2x）
- `.omo/evidence/m1/visual-details/bar-left.png`
- `.omo/evidence/m1/visual-details/bar-right.png`
- `.omo/evidence/m1/visual-details/bar-card-corners.png`
- `.omo/evidence/m1/visual-details/panel-info.png`
- `.omo/evidence/m1/visual-details/user-bubble.png`
- `.omo/evidence/m1/visual-details/code-block.png`（注：真实 S2 无 fenced code block，裁的是助手文本气泡）
- `.omo/evidence/m1/visual-details/sidebar-current-item.png`
- `.omo/evidence/m1/visual-details/shadow-bottom.png`
- `.omo/evidence/m1/visual-details/crops.json`

### JSON / 日志
- `.omo/evidence/m1/visual-capture.json` — 采集元数据（窗口 bounds/bar/panel/sidebar/settings）
- `.omo/evidence/m1/visual-qa.json` — 本任务的逐项 PASS/FAIL + 偏差
- `.omo/evidence/task-12-anchor.json`、`task-12-shape.txt`、`task-12-xprop.txt`、`task-12-clickthrough.log`
- `.omo/evidence/task-13-tray.json`、`task-13-summary.json`、`task-6-tray-summary.json`
- `.omo/evidence/task-14-tokens.json`、`task-14-network.json`
- `.omo/evidence/task-19-error.png`、`task-19-error-429.json`
- `.omo/evidence/task-20-search.png`、`task-20-search.json`、`task-20-history.json`
- `.omo/evidence/task-22-s4.json`、`task-22-onboarding.json`
- `.omo/evidence/task-23-blur.json`、`task-23-summary.json`
- `.omo/evidence/m1/nfr02.json`、`nfr02-frames.json`
- `.omo/evidence/m1/nfr04-kwin-introspection.json`
- `.omo/evidence/m1/nfr05-pixels.json`、`nfr05-summary.json`
- `.omo/evidence/m1/nfr07-summary.json`
- `.omo/evidence/m1/nfr-m1-unit.log`、`nfr-m1-e2e.log`
- `.omo/evidence/m1/history-1000-typecheck-build-test.log`

---

## 8. 最终判定

| 维度 | 结果 |
|---|---|
| S1/S2/S3 与手绘稿结构一致 | **PASS** |
| §3.3 几何 token | **PASS** |
| §3.4 条内排布/按钮顺序 | **PASS** |
| §3.5 面板/无输入 | **PASS** |
| §3.6 历史栏/当前标记 | **PASS** |
| §3.10 视觉规范（颜色/字体/CJK/圆角/阴影） | **PASS** |
| S4 720×560 / 系统标题栏 | **PASS** |
| 托盘（Task 6/13，Q4） | **PASS** |
| 点击穿透 / 条不位移 / 动画 | **PASS** |
| Blur | **PASS (degraded)** — KWin OFF，不伪造，不声称可用 |
| 未批准偏差 | **0** |
| **总判定** | **PASS** |
