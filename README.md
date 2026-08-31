# Codex Pocket

Codex Pocket 是一个最小的手机端 Codex 会话遥控器。电脑端通过本地
`codex app-server` 读取同一份会话存储，再经 Cloudflare Quick Tunnel 提供临时
HTTPS 入口。手机可以实时查看会话、发送新消息，并处理常见的命令与文件修改审批。
Codex App Server 始终只通过 stdio 连接，不会直接暴露到公网。

## Windows 使用

1. 双击 `CodexPocket.cmd`。
2. 点击“开启服务”。首次启动会从 Cloudflare 官方 GitHub Release 下载
   `cloudflared` 到项目的 `.tools` 目录。
3. 在手机浏览器打开窗口中的“公网链接”，输入“访问密钥”。
4. 打开一个空闲会话，在底部输入框发送任务；Codex 需要运行命令或修改文件时，
   可直接在手机上允许或拒绝。
5. 使用结束后点击“停止服务”，或直接关闭控制窗口。

窗口会同时停止本地查看器、Codex App Server 和公网隧道。每次开启都会生成新的
访问密钥，Quick Tunnel 的公网域名也可能变化。

若 Windows 防火墙拦截 Cloudflare Tunnel，可右键以 PowerShell 管理员身份运行
`OpenCloudflarePort.ps1`。该脚本只为项目内的 `cloudflared.exe` 放行出站
TCP/UDP 7844，不创建入站规则。

## macOS / Linux 使用

系统需具备 Python 3、Tkinter、Node.js 20+ 和 Codex CLI：

```bash
python3 codex_pocket.py
```

控制窗口会自动选择当前平台对应的 `cloudflared` 版本。
无图形桌面时可以使用 `python3 codex_pocket.py --headless`。

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
- 手机发送的消息会通过 `thread/resume` 和 `turn/start` 启动真实 Codex 回合。
- 同一会话一次只允许一个回合；正在电脑端执行的会话会拒绝手机并发发送。
- 命令与文件修改仍遵守 Codex 的审批策略，不会默认绕过批准。
- 审批时会显示必要的命令预览；页面不返回命令原始输出、文件 diff、环境变量或完整工作目录。
- 页面会展示原始对话文本；如果会话本身含有密码或密钥，手机端也能看到。请把公网链接和访问密钥视为敏感信息。
- 当前手机端只处理命令与文件修改审批，其他交互式请求仍需回电脑处理。
- Quick Tunnel 适合个人临时使用，不适合作为长期生产服务。

依据：[OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)
