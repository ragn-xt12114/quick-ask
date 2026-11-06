# M0 / G7 — Plasma 6 托盘（StatusNotifierItem）行为矩阵

> 历史设计/验收笔记：部分证据链接指向私有开发存档 `.omo/`，该目录不在本仓库中。


- 日期：2026-11-05
- 环境：Debian 13，X11 `DISPLAY=:0`，KWin 6.3.6 / Plasma 6，Electron 45.2.2
- Spike：`spike/tray.cjs`（不引用 `src/`）
- 图标：`assets/tray-spike.svg` → `assets/tray-spike-32.png`（`rsvg-convert` 本地生成，无 CDN）
- 菜单：固定 5 项 —— 显示/隐藏、新建会话、历史、设置、退出
- Tooltip：`QuickAsk test tray`
- Driver：`tools/tray-check.sh`；PIL 定位器：`tools/tray-probe.py`

## 1. 实际注册与定位

| 项目 | 实测值 |
|---|---|
| 面板 | 顶部 panel，X window `0x1804bb`（1574075），1920×56@0,0，初始 `_NET_WM_STATE_HIDDEN`（`IsUnMapped`） |
| 面板显示方式 | 使用用户已有的 Plasma 快捷键 `cycle-panels`（`Meta+Alt+P` 的 DBus 等价调用）临时显示；未改 `plasmashellrc`/面板配置，结束后恢复 `IsUnMapped` |
| System tray widget | `org.kde.plasma.systemtray` id 38，相对面板 `x=1253 y=8 w=416 h=40` |
| SNI watcher | 启动前 6 项；启动后 7 项，新项 `:1.2365/StatusNotifierItem` |
| SNI Id | `quickask-tray-spike_status_icon_1` |
| SNI ToolTip | `QuickAsk test tray`（`gdbus` 读取；Electron 的 SNI 对象没有 `Introspect`，`qdbus6` 的 `Properties.Get` 会报 `Cannot find`） |
| SNI Status / Category | `Active` / `ApplicationStatus` |
| SNI Menu | `/com/canonical/dbusmenu` |
| 图标位置 | **面板内**，不是 overflow；PIL 匹配到 `#ff00cc` 连通块 bbox `1350,18 20×20`，中心 **1360,28** |
| 是否打开 overflow | 否（图标直接在面板内可见；代码仍保留 overflow fallback，本次未触发） |

面板初始是自动隐藏状态。为了让真实点击有坐标，driver 用 `cycle-panels`
快捷键把面板显示出来；这只是运行时焦点/可见性操作，没有写入任何 Plasma
配置。清理后顶部面板重新为 `IsUnMapped`。

## 2. 真实输入行为（xdotool，非 DBus 代替）

每次点击前都重新确认顶部面板 `IsViewable`，点击坐标固定为图标中心
`1360,28`。点击后等待 700ms，截取整屏（`spectacle`），并抓取
Plasma 可见窗口列表判断是否出现 popup。

| 输入 | 实际命令 | Plasma 侧观察 | Electron 收到的 Tray 事件 | 菜单/popup | 证据 |
|---|---|---|---|---|---|
| 左键单击 | `xdotool click 1` | 无菜单；面板保持可见 | **1× `click`**（2026-11-04T17:22:36.624Z） | **无** | `task-6-tray-left.png`、`task-6-tray-left-events.json` |
| 右键单击 | `xdotool click 3` | 打开 Plasma DBusMenu：`112×143 @ 1345,47`，5 项全部可见 | **0 个 Electron 事件**（`right-click` 没有被发出） | **有** | `task-6-tray-right.png`、`task-6-tray-right-windows.json` |
| 右键菜单第一项 | 菜单内点击 `1401,69` | 菜单关闭 | **1× `MENU_CLICK`**，item=`显示/隐藏`，index=1（17:22:43.248Z） | 菜单关闭 | `task-6-tray-right-item.png`、`task-6-tray-right-menu-click.json` |
| 左键双击 | `xdotool click --repeat 2 --delay 100 1` | 无菜单；图标不消失 | **2× `click`**（17:22:47.552Z、17:22:47.652Z，间隔 100ms）；**没有 `double-click` 事件** | **无** | `task-6-tray-double.png`、`task-6-tray-double-events.json` |

补充事实：

- `mouse-down` / `mouse-up` / `mouse-enter` / `mouse-leave` 在本次 Linux/Plasma
  SNI 路径下均未发出（事件日志里只有 `click`）。
- 左键单击不会打开菜单；菜单只在右键（或 DBus `ContextMenu`）路径出现。
- 右键菜单点击第一项后，Electron 的 `Menu` item click 正常触发，说明
  `setContextMenu` + DBusMenu 链路可用。
- 双击没有被 Electron 折叠成一个事件；它被拆成两次 `click`。因此**不能**
  声称支持 F-01.3 的“双击”。

## 3. DBus 补充（确定性调用，不替代真实点击）

对同一个 SNI 项 `:1.2365/StatusNotifierItem` 调用：

| 调用 | 返回 | Electron 事件 | 菜单 |
|---|---|---|---|
| `org.kde.StatusNotifierItem.Activate 0 0` | `exit=0`，`()` | 1× `click`（17:22:50.543Z） | 无 |
| `org.kde.StatusNotifierItem.SecondaryActivate 0 0` | `exit=0`，`()` | 1× `click`（17:22:53.436Z） | 无 |
| `org.kde.StatusNotifierItem.ContextMenu 0 0` | `exit=0`，`()` | **0 事件** | **未观察到 popup** |

说明：

- Electron 的 SNI DBus 对象没有实现 `Introspect`，`qdbus6` 找不到
  `org.freedesktop.DBus.Properties.Get`；因此属性读取和补充调用使用
  `gdbus`/`dbus-send` 直接调用 well-known 方法。真实点击测试仍用 xdotool，
  DBus 只作为补充证据。
- `Activate` 与 `SecondaryActivate` 在 Electron 侧都表现为 `click`，无法从
  Tray API 区分左键/中键语义。
- `ContextMenu` 返回成功但没有弹出菜单；本机 Plasma 6 + Electron 45.2.2
  组合下不能把它当作“程序化弹菜单”的可靠路径。

## 4. 对 Q4 的结论

**Q4：左键 toggle vs menu-first（左键弹菜单）**

实测支持 **左键 toggle + 右键菜单**：

- 左键单击确实到达 Electron `click`，应用可以在回调里 toggle 主窗显示/隐藏。
- 右键单击由 Plasma 打开 5 项菜单，且菜单项回调正常；不需要把左键改成菜单。
- 双击不可用：Plasma/Electron 发出两次 `click`，没有 `double-click`。如果
  产品需要“双击做某事”，只能在 app 内对两次 `click` 做时间窗去重，但这会
  和用户快速点两次“显示/隐藏”冲突；不建议作为 M1 功能。
- 因此 M1 应按计划实现：**左键 toggle、右键菜单、菜单首项“显示/隐藏”**，
  并继续明确“不支持双击”（B.11 失败矩阵 / F-01.3）。
- 若未来实测某桌面环境把左键变成 menu-first，菜单首项仍应是 toggle；本次
   Plasma 6 没有这种强制行为。

## 5. PASS/FAIL

| 检查 | 结果 | 说明 |
|---|---|---|
| 32×32 PNG 本地生成（无 CDN） | **PASS** | `rsvg-convert` 生成 512/32；`task-6-tray-app.log` 记录 icon size 32×32、`image_empty=false` |
| SNI 注册 | **PASS** | watcher 新项 `:1.2365/StatusNotifierItem`；Id/ToolTip 正确 |
| 图标在 Plasma 面板可见 | **PASS** | PIL 定位 `1350,18 20×20`；`task-6-tray-panel.png` |
| 右键菜单 5 项可用 | **PASS** | popup `112×143`；5 项可见；点击第一项触发 `MENU_CLICK` |
| 左键真实点击事件 | **PASS** | 1× `click` |
| 双击行为记录 | **PASS（记录为“不支持”）** | 2× `click`，0× `double-click`；未声称支持 |
| DBus 补充 | **PASS（有边界）** | Activate/SecondaryActivate 触发 click；ContextMenu 无 popup |
| 无面板/Plasma 配置改动 | **PASS** | 只调用 `cycle-panels` 运行时快捷键；初始/最终面板均 `IsUnMapped` |
| 无残留 spike 进程 | **PASS** | 清理后 `no spike/tray.cjs processes left` |

**G7 判定：PASS（左键 toggle + 右键菜单可用；双击不支持，已按事实记录）。**

## 6. 限制

1. 面板在本机是 **autohide**；driver 用 `cycle-panels` 快捷键临时显示。
   这不是用户配置修改，但意味着截图中的面板可见性是测试驱动产生的。
2. 只做了一轮真实点击（每种输入一次）；事件时间戳和 popup 几何有快照，
   但没有做 100 次重复统计。M1 的托盘实现仍需在真实 app entry 下复测
   tray-ready / 菜单状态。
3. 本机没有触发 overflow 分支（图标直接可见）；`tools/tray-check.sh` 中
   保留了 fallback，但本次没有实测证据。Task 13/27 若在别的面板宽度下
   遇到 overflow，需要单独验证。
4. `ContextMenu` DBus 方法返回成功但未显示菜单；不要把它当作 M1 的菜单
   实现路径，生产实现仍应依赖 `Tray.setContextMenu` + 真实右键。
5. 没有测试键盘导航菜单、无障碍或菜单项动态标签；这些属于 Task 13。

## 7. 证据路径

- `.omo/evidence/task-6-tray-events.json`（全部 Tray 事件，含 TRAY_READY / SNI_LOOKUP / click / MENU_CLICK）
- `.omo/evidence/task-6-tray-app.log`
- `.omo/evidence/task-6-tray-driver.log`
- `.omo/evidence/task-6-tray-dbus.txt`（qdbus6 watcher + gdbus 属性）
- `.omo/evidence/task-6-tray-dbus-actions.txt` / `task-6-tray-dbus-actions.json`
- `.omo/evidence/task-6-tray-sni.json`
- `.omo/evidence/task-6-tray-icon-location.json`
- `.omo/evidence/task-6-tray-panel.png`
- `.omo/evidence/task-6-tray-left.png` / `task-6-tray-left-events.json` / `task-6-tray-left-windows.json`
- `.omo/evidence/task-6-tray-right.png` / `task-6-tray-right-windows.json`
- `.omo/evidence/task-6-tray-right-item.png` / `task-6-tray-right-menu-click.json` / `task-6-tray-right-item-events.json`
- `.omo/evidence/task-6-tray-double.png` / `task-6-tray-double-events.json` / `task-6-tray-double-windows.json`
- `.omo/evidence/task-6-tray-panel-state.json`
- `.omo/evidence/task-6-tray-summary.json`
- `.omo/evidence/task-6-tray-dbus-{activate,secondary,contextmenu}.png`
