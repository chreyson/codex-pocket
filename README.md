# Codex Pocket

Codex Pocket 是一个最小的手机端 Codex 会话遥控器。电脑端读取 Codex App 使用的
同一份会话数据，再通过 Cloudflare Quick Tunnel 提供临时 HTTPS 入口。手机可以
实时查看会话、发送新消息，并处理常见的命令与文件修改审批。

Codex App Server 始终只通过本机 stdio 连接，不会直接暴露到公网；本地 Web 服务也
只监听 `127.0.0.1`。

## Windows 一键部署

### 前置环境

- Windows 10 或 Windows 11。
- Python 3.8 或更高版本，并且可通过 `py -3` 或 `python` 调用。
- Node.js 20 或更高版本。
- Codex App 或 Codex CLI；先打开或运行一次，确认 API 登录配置可正常使用。
- Microsoft Edge WebView2 Runtime。Windows 10/11 通常已经预装；缺失时安装
  [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

在项目目录中打开“管理员 PowerShell”，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-CodexPocket.ps1 -Start
```

脚本可以重复运行，会依次：

1. 检查 Python、Node.js、Codex 和 WebView2。
2. 安装 `requirements-desktop.txt` 中的桌面依赖。
3. 从 Cloudflare 官方 GitHub Release 准备 `cloudflared`。
4. 为实际使用的 `cloudflared.exe` 幂等创建三条仅出站规则。
5. 验证各组件，写入 `.data/setup-result.json`，然后启动桌面应用。

如果电脑的出站流量本来就不受 Windows 防火墙限制，可以不修改防火墙，也不需要
管理员权限：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-CodexPocket.ps1 -SkipFirewall -Start
```

只部署、不立即启动时去掉 `-Start`。以后直接双击 `CodexPocket.cmd` 即可运行。

## 端口说明

部署脚本只为 `cloudflared.exe` 创建以下出站规则：

| 方向 | 协议与远端端口 | 用途 |
| --- | --- | --- |
| 出站 | UDP 7844 | Cloudflare Tunnel 的 QUIC 首选连接 |
| 出站 | TCP 7844 | QUIC 不可用时的 HTTP/2 连接 |
| 出站 | TCP 443 | Quick Tunnel 建立、HTTPS 控制请求及回退连接 |

不创建 Windows 入站规则，不需要在路由器上做端口映射，也不需要公网 IP。手机的
HTTPS 请求先到 Cloudflare，再沿电脑主动建立的出站隧道返回本机服务。本地查看器
使用随机端口并仅监听 `127.0.0.1`，不会监听 `0.0.0.0`。

若只想重新配置端口，可在 `cloudflared` 已准备好后，以管理员身份单独运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\OpenCloudflarePort.ps1
```

该脚本的结果写入 `.data/firewall-result.json`。

## 使用方法

1. 打开 Codex Pocket，点击“开启服务”。
2. 在手机浏览器打开窗口中的“公网链接”，输入本次生成的“访问密钥”。
3. 选择一个空闲会话，在底部发送任务；需要运行命令或修改文件时，可在手机上允许
   或拒绝常见审批。
4. 使用结束后点击“停止服务”，或关闭桌面窗口。

窗口会同时停止本地查看器、Codex App Server 和公网隧道。每次开启都会生成新的
访问密钥，Quick Tunnel 的公网域名也可能变化。桌面控制器只允许一个实例运行，
重复双击不会启动第二套端口和隧道。

## 验证与排障

查看最近一次完整部署结果：

```powershell
Get-Content .\.data\setup-result.json
```

查看 Codex Pocket 创建的防火墙规则：

```powershell
Get-NetFirewallRule -Group 'Codex Pocket' |
    Get-NetFirewallPortFilter |
    Format-Table Protocol, RemotePort
```

常用排障文件：

- `.data/setup-result.json`：环境检查、组件路径、版本和部署错误。
- `.data/firewall-result.json`：单独运行端口脚本时的规则结果。
- `.data/desktop.log`：本地服务和 Cloudflare Tunnel 启动日志。

如果部署提示找不到 Codex，请先打开一次 Codex App，或确认 `codex` 已加入 `PATH`。
如果公网链接迟迟不出现，先检查 `desktop.log`，再确认公司网络、代理或安全软件允许
上述三个出站端口。Quick Tunnel 适合个人临时访问，不适合作为长期生产服务。

## macOS / Linux

系统需具备 Python 3、Tkinter、Node.js 20+ 和 Codex CLI：

```bash
python3 codex_pocket.py
```

控制窗口会自动选择当前平台对应的 `cloudflared` 版本。无图形桌面时可以使用
`python3 codex_pocket.py --headless`。`Setup-CodexPocket.ps1` 和 Windows 防火墙
规则不适用于 macOS/Linux；这些系统通常只需允许 `cloudflared` 发起上述出站连接。

## 开发与测试

```powershell
npm test
npm run test:desktop
```

也可以仅启动本地查看器：

```powershell
npm start
```

此时访问密钥保存在 `.data/access-token`，本地地址为
`http://127.0.0.1:4173/`。

## 安全边界

- Web 服务只监听 `127.0.0.1`，公网入口由临时 HTTPS 隧道提供。
- 每次桌面启动生成独立的高熵访问密钥，停止后立即失效。
- 当 Codex App 正在运行时，手机消息会通过 App 的本机工具管道交给
  `send_message_to_thread`，由持有会话的桌面 App 启动回合，不会用第二个 App
  Server 抢占同一会话的 writer。
- 未检测到 Codex App 时才回退到独立 App Server 的 `thread/resume` 和
  `turn/start`，用于 CLI 会话兼容。
- 同一会话一次只允许一个回合；正在电脑端执行的会话会拒绝手机并发发送。
- 命令与文件修改仍遵守 Codex 的审批策略，不会默认绕过批准。
- 审批时会显示必要的命令预览；页面不返回命令原始输出、文件 diff、环境变量或
  完整工作目录。
- 页面会展示原始对话文本；如果会话本身含有密码或密钥，手机端也能看到。请把
  公网链接和访问密钥视为敏感信息。
- 当前手机端只处理命令与文件修改审批，其他交互式请求仍需回电脑处理。

依据：[OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)
