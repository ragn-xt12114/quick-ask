# Contributing

感谢参与 QuickAsk。这个项目是 Electron + React + TypeScript 的本地优先桌面问答条；
提交前请先读 `docs/WINDOWS.md` 的平台差异和已知限制。

## 环境

- Node.js ≥ 24（`package.json` engines）
- Linux X11：构建 X11 helper 需要 `gcc`、`libx11-dev`、`libxext-dev`
- Windows 10/11：不需要 gcc / Visual Studio，`@napi-rs/keyring` 使用预编译二进制
- 密钥环：Linux 用 Secret Service/KWallet；Windows 用 Credential Manager

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Linux e2e 需要真实 X11 会话（`DISPLAY=:0`）以及 `xdotool`、`xprop` 等工具：

```bash
DISPLAY=:0 npx playwright test
```

像素对比用例需要 Python 3 + Pillow；如果它不在默认 `python3`，先导出
`PYTHON=/path/to/python`。

CI 只跑 `typecheck` / `lint` / `test` / `build`，**不跑 e2e**（无 X11，容易假红）。

> e2e 通过 `xdotool` 发送全局热键。运行前请确保当前焦点不在会抓取键盘的虚拟机窗口
> （VirtualBox/VMware 等）；这类窗口会吞掉 XTest 事件，导致热键用例假失败。

## 目录约定

- `src/main/`：Electron 主进程。平台判断只能放在 `src/main/platform/`，
  ESLint 会拒绝其他位置的 `process.platform`。
- `src/renderer/`：React 渲染层，不直接访问 Node/Electron。
- `src/shared/`：IPC 线协议与纯函数，禁止导入 Electron 或 Node 内置模块。
- `native/`：Linux X11 helper；Windows 上 `npm run build:native` 会跳过。
- `tests/unit` / `tests/integration`：Vitest；`tests/e2e`：Playwright + Electron。

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```text
feat(platform): add win32 click-through adapter
fix(settings): keep watchdog disabled on Windows
docs: rewrite public README
chore(repo): stop tracking .omo
```

- 标题用祈使句、不超过 72 字符。
- 正文说明“为什么”，不要只复述 diff。
- 一个提交只做一件事；格式化/重命名与行为改动分开。

## Pull Request

PR 描述至少包含：

1. 改了什么、为什么。
2. 影响的平台（Linux X11 / Windows 10/11 / 两者）。
3. 本地执行的命令与结果（`typecheck`、`lint`、`test`、`build`，涉及 UI 时附 e2e）。
4. 新增/变化的能力状态；如果是 `degraded` 或 `unsupported`，写清原因和 UI 文案。
5. 未验证项（例如“未在 Windows 实机跑过”），不要隐瞒。

合并前必须满足：

- `npm run typecheck` 0 error
- `npm run lint` 0 error
- `npm test` 全绿
- `npm run build` 成功
- 没有新增运行时依赖（确需新增先在 issue/PR 里说明理由）
- 没有提交密钥、个人绝对路径、`.omo/`、`.env`、数据库文件

## 平台能力

新增平台能力时：

1. 在 `src/shared/platform.ts` 定义 wire type 与三态。
2. 在 `src/main/platform/types.ts` 增加适配器接口。
3. 为 Linux / win32 / noop 分别实现；任何实现都不得抛异常。
4. 在 `BootstrapInfo.platformCapabilities` 暴露，并在设置 → 关于 → 平台能力里用
   现有样式展示“可用/受限/不支持 + 原因”。
5. 加单元测试覆盖选择器、win32 不调用 X11 helper、以及失败路径。

## License

提交即表示同意以 [MIT](./LICENSE) 许可发布。
