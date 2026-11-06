# Windows 支持说明

QuickAsk 0.1.2 起提供 Windows 10/11 x64 支持。Windows 与 Linux X11 共用同一套
Electron 主进程、SQLite 历史、SSE 流式回答和设置界面；平台差异集中在
`src/main/platform/`，并且全部通过类型化的三态能力（`available` / `degraded` /
`unsupported` + `reason`）暴露给界面，不会假装支持。

> 当前仓库内的 Windows 产物只做了**交叉打包冒烟验证**（Linux 上
> `electron-builder --win --dir`）。真机功能验证清单见文末，需在 Windows 10/11
> 实机执行；未执行前不要把“可打包”当成“已实机验证”。

## 1. 能力矩阵

| 能力 | Linux X11 | Windows 10/11 | 说明 |
|---|---|---|---|
| 全局热键 | 可用 | 可用 | 主键均为 `Control+Alt+Space`；Linux 备选 `Control+Shift+Space` / `Control+Alt+K` / `Super+Space`，Windows 备选 `Control+Shift+Space` / `Control+Alt+K` / `Control+Shift+K`。Windows 不使用 `Super+Space`（抢 Win 键）和 `Alt+Space`（系统窗口菜单）。 |
| 托盘 / 单实例 / 登录后隐藏启动 | 可用 | 可用 | 托盘图标仍为 `assets/tray-32.png`；登录启动只驻留托盘，不自动弹主窗口。 |
| 无边框透明窗口 / 圆角 / 置顶 | 可用 | 可用 | Windows 用 `transparent: true` + CSS 圆角；始终置顶用 `setAlwaysOnTop`。 |
| 点击穿透 | 可用（精确 shape） | **受限（degraded，整窗切换）** | Linux 由 X11 helper 设置 `ShapeInput`/`ShapeBounding`，只有胶囊条/面板/历史栏接收点击，12px 间隙精确穿透。Windows 没有等价 shape API，改用 `setIgnoreMouseEvents(true, { forward: true })`，按光标是否落在卡片内整窗切换；切换轮询 50ms，边缘有最多约 50ms 延迟，透明边距在切换前可能短暂拦截点击。 |
| 毛玻璃 | 可用（取决于 KWin） | **不支持** | Windows 10 没有 acrylic，Windows 11 的 `backgroundMaterial` 不能覆盖 Win10；统一返回 `unsupported` 并显示原因，改用半透明纯色卡片，不伪造 `backdrop-filter`。 |
| 字体 | 可用（`fc-list`） | **受限（固定候选）** | Windows 不枚举系统字体，固定返回 Microsoft YaHei UI / Segoe UI / Consolas / Cascadia Mono，`source: 'static'`；界面会标注“受限”。 |
| 登录自启动 | 可用（XDG `.desktop`） | 可用（登录项） | Windows 走 `app.setLoginItemSettings` 写 HKCU Run，并用 `getLoginItemSettings` 读回；设置页展示注册表位置。 |
| 看门狗守护 | 可用 | **不支持** | 守护脚本是 Bash + `flock`，仅 Linux；Windows 会强制关闭该选项并在设置页显示原因。 |
| X11 原生 helper | 可用（需本地编译） | 不适用 | `native/quickask-x11` 是 Linux ELF，不进入 Windows 包，也不会在 Windows 上执行。 |
| 本地数据 | XDG 路径 | `%APPDATA%` / `%LOCALAPPDATA%` | 见第 4 节。 |
| 打包 | `dir` / `deb` | `nsis` / `portable` | `linux.target` 保持 `dir` 不变；Windows 产物由 `npm run dist:win` 生成。 |

三态含义：

- `available`：该平台原生支持，UI 正常展示。
- `degraded`：可用但与 Linux 行为不同，UI 标注“受限”并给出原因。
- `unsupported`：该平台没有实现，UI 标注“不支持”并给出原因；不会静默失败。

## 2. 架构位置

| 文件 | 作用 |
|---|---|
| `src/shared/platform.ts` | 渲染层/主进程共用的能力 wire types（无 Electron 依赖）。 |
| `src/main/platform/types.ts` | 窗口、模糊、字体、自启动适配器接口。 |
| `src/main/platform/index.ts` | 按 `process.platform` 选择适配器；未知平台走 no-op。 |
| `src/main/platform/linux.ts` | 保留原 X11 / KWin / fc-list / XDG 行为。 |
| `src/main/platform/win32.ts` | Windows 点击穿透轮询、固定字体、unsupported 模糊、登录项自启动。 |
| `src/main/platform/noop.ts` | 未适配平台：全部能力 unsupported，不抛异常。 |
| `src/main/platform/paths.ts` | Linux XDG 与 Windows Roaming/Local 路径解析（纯 Node）。 |
| `src/main/startup/login-item.ts` | Windows `setLoginItemSettings` + 读回校验。 |

约束：`src/main/` 下除 `src/main/platform/` 外不允许出现 `process.platform`
判断；ESLint 已加 `no-restricted-syntax` 规则强制这一点。

## 3. 构建

### 3.1 在 Windows 上构建（推荐）

前置：

- Windows 10/11 x64
- Node.js ≥ 24（`package.json` engines）
- 无需 Visual Studio / gcc：`@napi-rs/keyring` 使用预编译二进制，X11 helper 在
  Windows 上自动跳过
- 首次 `npm ci` 需要网络；electron-builder 会下载 Windows 版 Electron 与 NSIS

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run dist:win
```

产物：

- `release/win-unpacked/`：免安装目录版，双击其中的 `quickask.exe`
- `release/QuickAsk-<version>-setup.exe`（NSIS 安装包）
- `release/QuickAsk-<version>-portable.exe`（便携版，具体文件名以 electron-builder 输出为准）

未签名产物会触发 SmartScreen 提示；这是预期行为，公开发布前应配置代码签名证书。

### 3.2 在 Linux 上交叉打包（仅冒烟）

```bash
npm ci
npm run build
npx electron-builder --win --dir
```

本仓库验证机已安装 `wine`。交叉打包只证明“能产出 Windows 目录包”，**不能**证明
热键、托盘、点击穿透、登录项在真实 Windows 上工作。失败时请贴完整原始报错，不要
把交叉打包成功当作实机验证。

### 3.3 Linux 原生构建

`npm run build:native` 现在走 `scripts/build-native.mjs`：非 Linux 平台直接打印
跳过日志并 `exit 0`，不会尝试调用 `bash` 或 `gcc`。`native/build.sh` 自身也有
`uname -s` 守卫。

## 4. 数据、配置与日志路径

| 内容 | Linux | Windows |
|---|---|---|
| 配置 / Chromium 状态 | `${XDG_CONFIG_HOME:-~/.config}/quickask` | `%APPDATA%\QuickAsk` |
| 数据库 | `${XDG_DATA_HOME:-~/.local/share}/quickask/quickask.db` | `%LOCALAPPDATA%\QuickAsk\quickask.db` |
| 日志 | `${XDG_STATE_HOME:-~/.local/state}/quickask/logs` | `%LOCALAPPDATA%\QuickAsk\logs` |
| 崩溃转储 | `<配置目录>/Crashpad` | `%LOCALAPPDATA%\QuickAsk\Crashpad` |
| 自启动 | `${XDG_CONFIG_HOME:-~/.config}/autostart/quickask.desktop` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\QuickAsk` |

覆盖：`QUICKASK_DATA_DIR` 在两端都优先级最高（只影响数据库目录）。Windows 上
配置放 Roaming、日志/数据库/崩溃转储放 Local，避免 SQLite WAL 漫游同步造成锁冲突。

> 如果曾用开发版在 Windows 上运行过更早的构建，旧数据可能在
> `%USERPROFILE%\.config\quickask`（早期版本误用 XDG 路径）。公开版本不会自动迁移；
> 需要时手动把 `quickask.db` 及其 `-wal`/`-shm` 移到新目录。

## 5. 安全与隐私

- API key 与额外请求头只进 Windows Credential Manager（`@napi-rs/keyring`）或
  Electron `safeStorage`（DPAPI）加密回退；数据库、配置、日志中没有明文 key。
- 无遥测、无自动更新检查、无崩溃上报；渲染层 CSP `connect-src 'none'`，网络请求
  只由主进程发往用户配置的 endpoint。
- 日志脱敏规则与 Linux 相同；错误详情截断 300 字。

## 6. Windows 真机验证清单（Hermes 执行）

每一步都要记录“实际现象”；不符合预期判据即失败，不要跳过。

### 6.1 免安装目录版

1. 解压 `release/win-unpacked/` 到普通用户目录（不要放 `Program Files`）。
2. 双击 `quickask.exe`。
   - 预期：进程启动，系统托盘出现 QuickAsk 图标；主窗口不自动显示。
   - 失败判据：闪退、托盘无图标、控制台出现 `Cannot find module` /
     `node:sqlite` 错误、Windows Defender 直接隔离。
3. 按 `Control+Alt+Space`。
   - 预期：胶囊条在光标所在屏幕出现并聚焦；再按一次隐藏。
   - 失败判据：无反应；或按 `Super+Space`/`Alt+Space` 才响应（说明 fallback 选错）。
4. 在输入框输入一条消息并回车（需要先在设置里配置一个可用的 OpenAI 兼容端点）。
   - 预期：流式输出；结束后内容进入历史。
   - 失败判据：401/429 以外的网络错误、界面卡死、回答不入库。
5. 点托盘 → 历史 / 设置。
   - 预期：历史列表可打开会话；设置窗口可改主题、条宽、字体、透明度；毛玻璃
     开关置灰并显示“当前平台不支持毛玻璃…”；看门狗置灰并显示“仅 Linux”。
   - 失败判据：设置页空白、点击无响应、毛玻璃开关可点但无效果、看门狗可开启。
6. 点击胶囊条外的透明边距（约 12px 区域）。
   - 预期：点击落到桌面/下层窗口（degraded 模式下允许 ≤50ms 延迟；快速点击可能
     偶尔被窗口接住，这是已知降级）。
   - 失败判据：透明区域长期拦截点击，或胶囊条本身无法点击/无法输入。
7. 设置 → 登录与守护 → 勾选“登录时自启动”。
   - 预期：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\QuickAsk` 出现，
     设置页显示“已启用”；取消勾选后该值消失。
   - 失败判据：写不进去、写进去但读回失败、取消后仍残留。
8. 托盘 → 退出。
   - 预期：进程退出，托盘图标消失，SQLite 正常 checkpoint（无 `-wal` 残留锁）。
   - 失败判据：进程残留、托盘图标残留、下次启动提示数据库损坏。

### 6.2 NSIS 安装包

1. 运行 `QuickAsk-<version>-setup.exe`，按默认选项安装。
   - 预期：安装到 `%LOCALAPPDATA%\Programs\QuickAsk`（electron-builder NSIS 默认），
     开始菜单/桌面快捷方式可选。
2. 从快捷方式启动，重复 6.1 的 2–8 步。
3. 控制面板卸载。
   - 预期：程序文件与快捷方式移除；`%APPDATA%\QuickAsk` 和
     `%LOCALAPPDATA%\QuickAsk` 中的用户数据保留（当前安装包不主动删数据）。
   - 失败判据：卸载后仍有进程/开机项残留，或用户数据被静默删除。

### 6.3 便携版

1. 运行 `QuickAsk-<version>-portable.exe`。
   - 预期：无需安装即可启动；数据仍写入 `%APPDATA%` / `%LOCALAPPDATA%`（便携版
     不改变数据目录）。
   - 失败判据：要求管理员权限、启动后找不到托盘、数据写到临时目录并随退出丢失。

### 6.4 建议补充

- 125% / 150% 缩放各跑一次步骤 3、6（点击穿透边界）。
- 双屏（不同 DPI）把主窗口拖到副屏后重复步骤 3、6。
- 中文输入法（微软拼音）组合期按 Enter/Esc，确认不误发（Linux fcitx5 有已知宿主
  行为；Windows 需实机记录）。
- 断网/超时/401 各一次，确认错误可见且 key 不出现在日志。

## 7. 已知限制

- 点击穿透是整窗开关，不是精确 shape；50ms 轮询带来边缘延迟。
- 毛玻璃在 Windows 上不可用（Win10 无 acrylic，Win11 的 Mica 不能跨版本）。
- 看门狗守护仅 Linux。
- 字体只提供 4 个固定候选，不枚举系统字体。
- Windows 产物未签名；未做自动更新、未做 ARM64 构建。
- 真机验证（第 6 节）尚未在本次改动中执行；在 Hermes 回报前，Windows 支持状态是
  “可构建 + 代码路径已测试”，不是“已实机验收”。
