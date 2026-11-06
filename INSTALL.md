# QuickAsk Linux 安装与卸载

本文覆盖 Linux X11 下的 `.deb` 与 `linux-unpacked` 两种形态。Windows 见
[`docs/WINDOWS.md`](docs/WINDOWS.md)。

## 1. 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Linux x64 + X11 会话（KDE Plasma 已实测；Wayland 不支持） |
| Node.js | ≥ 24（`package.json` engines） |
| 编译工具 | `gcc`、`make` |
| X11 开发库 | `libx11-dev`、`libxext-dev` |
| 托盘 | 支持 StatusNotifier/AppIndicator 的桌面 |
| 密钥环 | Secret Service：KWallet（KDE）或 gnome-keyring（GNOME） |
| 可选 | `desktop-file-utils`（`desktop-file-validate`、`update-desktop-database`） |

Debian/Ubuntu：

```bash
sudo apt install -y build-essential libx11-dev libxext-dev desktop-file-utils
```

## 2. 构建

在仓库根目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### 2.1 目录版（linux-unpacked）

```bash
npm run dist:dir
./release/linux-unpacked/quickask
```

启动后驻留托盘，主窗口默认隐藏；未配置模型时会自动打开设置向导。

### 2.2 `.deb` 安装包

```bash
npm run dist:deb
ls release/quickask_*_amd64.deb
sudo apt install ./release/quickask_*_amd64.deb
```

`.deb` 默认安装到 `/opt/QuickAsk`，由 electron-builder 生成桌面入口与依赖声明。
卸载使用系统包管理器：

```bash
sudo apt remove quickask
```

## 3. 桌面菜单项（目录版）

目录版不会自动写桌面入口。可手动生成：

```bash
bash tools/make-desktop.sh
desktop-file-validate build/quickask.desktop release/quickask.desktop
install -Dm644 release/quickask.desktop ~/.local/share/applications/quickask.desktop
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

`tools/make-desktop.sh` 使用当前仓库路径生成 `Exec=`，移动 checkout 后重新执行即可。

## 4. 自启动

设置 → 行为 → 登录与守护：

- 开启后写入 `${XDG_CONFIG_HOME:-~/.config}/autostart/quickask.desktop`。
- 看门狗开启时 `Exec` 指向 `scripts/quickask-supervisor.sh`；关闭时指向应用可执行文件。
- 开发态可用 `QUICKASK_AUTOSTART_EXEC` 覆盖整条命令。
- 守护进程用 `flock` 保证单实例；`QUICKASK_SUPERVISOR_STOP` 可放置停止文件。

## 5. 密钥环与数据

- API key 优先写 Secret Service/KWallet；不可用时用 Electron `safeStorage` 加密回退
  （`secrets.enc`，0600）；仍不可用时仅本次会话内存保存，界面提示 `SESSION_ONLY`。
- 数据路径：

| 内容 | 默认路径 | 覆盖 |
|---|---|---|
| 数据库 | `~/.local/share/quickask/quickask.db` | `QUICKASK_DATA_DIR` / `XDG_DATA_HOME` |
| 配置 | `~/.config/quickask` | `XDG_CONFIG_HOME` |
| 日志 | `~/.local/state/quickask/logs/quickask.log` | `XDG_STATE_HOME` |
| 崩溃转储 | `~/.config/quickask/Crashpad` | 跟随配置目录 |

`QUICKASK_DATA_DIR` 优先级最高，只影响数据库目录。

## 6. 卸载与清理

```bash
# 目录版：删除程序目录即可
rm -rf release/linux-unpacked

# .deb
sudo apt remove quickask

# 可选：用户数据（会删除历史与配置，请先备份）
rm -rf ~/.local/share/quickask
rm -rf ~/.config/quickask
rm -rf ~/.local/state/quickask
rm -f ~/.config/autostart/quickask.desktop
```

历史不会随程序目录删除而自动清除；需要保留请先导出或备份 `quickask.db`。

## 7. 常见问题

- **托盘图标不出现**：确认桌面支持 StatusNotifier/AppIndicator；KDE 可在“系统托盘 →
  配置”里检查 QuickAsk 是否被隐藏。
- **毛玻璃不可用**：设置 → 外观会显示具体原因（合成器未运行 / KWin 模糊效果未开启）。
  应用不会伪造模糊，只使用纯色/透明度回退。
- **热键冲突**：应用会自动尝试备选键并提示；释放冲突快捷键后可在设置里重试主键。
- **Wayland**：应用固定使用 `ozone-platform=x11`；Wayland 会话需要切换到 X11 登录。
