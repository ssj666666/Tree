# Tree 桌面端（Windows）

Electron 客户端：把跑在阿里云服务器上的 Tree 网页版装进一个桌面窗口。
服务器 24/7 在云端运行，App 只是一个客户端；关掉自己的电脑也不影响
服务器，App 里登录一次后靠会话 Cookie 保持登录，和浏览器里一样
（不存任何账号密码）。

## 功能

- 主窗口加载 Tree 网页版（默认 http://59.110.24.80:8787），聊天和按住说话
  都和网页版一样；麦克风权限只放行 Tree 服务器的源。
- 系统托盘：点右上角 × 是隐藏到托盘（不退出），双击托盘图标显示窗口；
  托盘菜单有 显示 / 隐藏 / 重新连接 / 设置服务器地址 / 退出。
- 全局快捷键：默认 Ctrl+Alt+T 显示/隐藏窗口。被占用时弹一次提示，
  不崩溃，可在设置里换。
- 桌面通知：窗口隐藏或最小化时，有新的机器人回复就弹 Windows 通知，
  点通知回到窗口。实现方式：主进程用会话 Cookie（tree_session）直连
  服务器的 /api/events SSE 流（只读），不改服务器任何代码。只在回复
  写完（streaming 结束）时通知一次；窗口可见时不打扰。
- 设置窗口（托盘菜单 → 设置服务器地址…）：改服务器地址和快捷键。
  保存后立即生效；换了服务器地址需要重新登录。
- 窗口大小/位置会记住（存在用户数据目录，不在 config 里）。

## 配置

读取顺序：exe 旁边的 config.json → 用户数据目录的 config.json →
内置的 config.json。设置窗口保存时：解压文件夹安装写到 exe 旁边；
便携版 exe（每次解压到临时目录运行）写到用户数据目录，这样设置
重启后还在。

## 开发

```sh
cd desktop
npm install
npm start            # Linux 下调试运行（需 Xvfb 或桌面环境）
node test-notifier.js  # 通知逻辑的单元测试
npm run dist         # 打 Windows 包（dir + portable，需联网下载 Electron）
```

打包产物在 `dist/`：`win-unpacked/`（解压即用的文件夹）和
`Tree-1.0.0-portable.exe`（单文件便携版）。exe 未签名，Windows 首次
运行会弹 SmartScreen，点“更多信息 → 仍要运行”。

## 文件

- `main.js` — 主进程：窗口、托盘、快捷键、通知（SSE）、设置 IPC
- `notifier.js` — 通知判定逻辑（可单元测试）+ SSE 帧解析
- `preload.js` — 仅设置窗口用的最小桥接
- `settings.html` — 设置窗口页面
- `config.json` — 默认服务器地址与快捷键
- `assets/icon.png` / `assets/icon.ico` — 图标
- `test-notifier.js` — 通知逻辑测试（不打包）
