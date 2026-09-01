# Codex Pocket

Codex Pocket 是一个最小的手机端 Codex 会话遥控器。电脑端读取 Codex App 使用的
同一份会话数据，再通过 Cloudflare Quick Tunnel 提供临时 HTTPS 入口。手机可以
实时查看回复增量、思考、工具活动和对话图片，发送文字或图片消息，中断或继续任务，
并处理常见的命令与文件修改审批。

Web composer 会直接读取当前 Codex 账户和项目的能力目录，支持选择模型、该模型实际
支持的推理强度、一个或多个 Skill，以及“执行 / 计划 / 目标”工作模式。模型和强度
不会在 Pocket 中维护静态名单，因此 Codex 升级或账户权限变化后会自动同步。

Codex App Server 始终只通过本机 stdio 连接，不会直接暴露到公网；本地 Web 服务也
只监听 `127.0.0.1`。

## 安装与启动

### 通用前置环境

- Python 3.8 或更高版本。
- Node.js 20 或更高版本。
- Codex App 或 Codex CLI；先打开或运行一次，确认 API 登录配置可正常使用。
- 项目目录必须对当前用户可写。下载或克隆后请保留整个目录，不要只复制启动文件。

安装器会自动准备 Python 桌面依赖和当前系统、处理器架构对应的 `cloudflared`。首次安装
需要访问 Python 包索引和 Cloudflare 的 GitHub Release。

### Windows

支持 Windows 10/11。系统还需要 Microsoft Edge WebView2 Runtime，通常已经预装；
缺失时安装 [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

首次使用直接双击 `Install-CodexPocket.cmd`。安装窗口会自动切换到项目目录、检查环境、
准备依赖并打开 Codex Pocket，不需要手动输入命令。以后双击 `CodexPocket.cmd` 即可。

普通双击不需要管理员权限，也不会修改防火墙。如果公司安全策略阻止 Cloudflare
Tunnel，可右键安装器并选择“以管理员身份运行”；此时只配置三条出站规则。

### macOS

支持 Intel 与 Apple Silicon Mac。首次使用双击 `Install-CodexPocket.command`；如果
macOS 首次拦截脚本，可在 Finder 中右键该文件并选择“打开”。安装器会在项目内创建
独立的 `.venv`，安装 Cocoa 桌面后端，并选择正确架构的 `cloudflared`。以后双击
`CodexPocket.command` 启动。

如果第三方 ZIP 工具移除了 Unix 执行权限，可在项目目录一次性运行
`chmod +x *.command *.sh`，之后仍按双击流程使用。

从 Finder 启动时通常不会加载 `.zshrc`。安装器会额外检查 Homebrew、MacPorts、Volta、
nvm、fnm、asdf、mise、Bun 和常见用户级目录，因此这些位置中的 Node/Codex 不要求
额外加入 Finder 的 `PATH`。

### Linux

支持带 X11 或 Wayland 图形桌面的主流 x86_64/arm64 发行版。在文件管理器的“属性 / 权限”
中允许脚本作为程序执行，然后双击 `Install-CodexPocket.sh` 并选择“在终端中运行”。
以后双击 `CodexPocket.sh` 启动。

安装器会创建项目内 `.venv`。如果当前 Python 环境已有可用的 GTK/WebKit 后端会直接
使用；否则在该 venv 中安装 PySide6/Qt，不会调用 `sudo` 或修改系统 Python。Debian/
Ubuntu 如果不能创建 venv，需要先安装 `python3-venv`；极简桌面缺少 Qt 原生库时，
请根据错误补充发行版对应的 XCB、EGL 和字体运行库。

无图形桌面的服务器可以使用：

```sh
./CodexPocket.sh --headless
```

### 跨电脑与非标准安装

`.data/`、`.tools/` 和 `.venv/` 都不会提交到 Git。每台电脑首次使用时都应运行对应系统
的安装器，由它发现并验证本机 Python、Node.js 和 Codex。项目目录移动后，启动器会
重新验证绝对路径；不可移动的旧 venv 会在再次安装时重建。

Windows 支持 Python Launcher、Conda、nvm-windows、Volta、Scoop 和标准安装。macOS/
Linux 支持 Homebrew、MacPorts、nvm、fnm、Volta、asdf、mise、Bun、Conda 和常见系统/
用户目录。企业镜像或便携版工具可通过高级入口显式指定 Windows 可执行文件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-CodexPocket.ps1 `
  -PythonPath "D:\Tools\Python\python.exe" `
  -NodePath "D:\Tools\Node\node.exe" `
  -CodexPath "D:\Tools\Codex\codex.cmd" `
  -SkipFirewall -Start
```

这些参数只用于选择本机运行时，不会写入仓库。macOS/Linux 可在运行安装器时使用
`POCKET_PYTHON`、`NODE_BIN` 和 `CODEX_BIN` 环境变量提供非标准路径。

## 网络与端口

仅当 `Install-CodexPocket.cmd` 以管理员身份运行时，安装器才为 `cloudflared.exe` 创建
以下出站规则：

| 方向 | 协议与远端端口 | 用途 |
| --- | --- | --- |
| 出站 | UDP 7844 | Cloudflare Tunnel 的 QUIC 首选连接 |
| 出站 | TCP 7844 | QUIC 不可用时的 HTTP/2 连接 |
| 出站 | TCP 443 | Quick Tunnel 建立、HTTPS 控制请求及回退连接 |

不创建 Windows 入站规则，不需要在路由器上做端口映射，也不需要公网 IP。手机的
HTTPS 请求先到 Cloudflare，再沿电脑主动建立的出站隧道返回本机服务。本地查看器
使用随机端口并仅监听 `127.0.0.1`，不会监听 `0.0.0.0`。

若之后需要补充或刷新规则，右键 `Install-CodexPocket.cmd` 并选择“以管理员身份运行”
即可；重复部署是幂等的，不会创建重复规则。规则结果也会写入部署结果文件。

macOS/Linux 安装器不修改系统防火墙。这些系统只需允许 `cloudflared` 主动访问下表中的
远端端口，不需要开放入站端口。

## 使用方法

1. 打开 Codex Pocket，点击“开启服务”。
2. 在手机浏览器打开窗口中的“公网链接”，输入本次生成的“访问密钥”。
3. 选择会话，在底部选择模型、推理强度、模式和所需 Skill，然后发送任务。打开会话会
   直接定位到最新消息，旧回合默认折叠且可按需展开。项目标题右侧的 `+` 可在同一项目
   中新建会话。
4. 任务运行时输入框仍可编辑：“等待”会在当前回合完成后自动发送下一条消息，`Steer`
   会把消息立即送入当前回合；右侧独立的停止按钮用于中断。每个会话最多保留一条等待
   消息。需要运行命令或修改文件时，可在手机上允许或拒绝常见审批。
5. 点击输入框左侧的图片按钮可从手机相册或文件中选择图片；对话中的图片可点击全屏
   查看。
6. 使用结束后点击“停止服务”，或关闭桌面窗口。

窗口会同时停止本地查看器、Codex App Server 和公网隧道。每次开启都会生成新的
访问密钥，Quick Tunnel 的公网域名也可能变化。桌面控制器只允许一个实例运行，
重复双击不会启动第二套端口和隧道。

### Composer 选项

- **模型与推理强度**：模型来自 App Server 的 `model/list`；切换模型后，只显示该
  模型支持的强度。选择会保存在当前浏览器中，并在服务端再次校验。
- **Skills**：列表来自当前会话工作目录的 `skills/list`，支持搜索和多选。发送时使用
  App Server 的结构化 Skill 输入，Skill 的本机路径不会返回浏览器。
- **图片**：支持 PNG、JPEG、WebP 和 GIF；单张不超过 12 MB，每条消息最多 4 张。
  可以只发送图片，也可以附带文字；目标模式首次创建目标时仍需要输入目标文字。只有
  支持图片输入的模型才会启用图片按钮。桌面会话中的本地图片、图片查看结果和生成图片
  也会显示在 Web 端。
- **执行**：使用 Codex 默认协作模式。
- **计划**：使用 App Server 原生 `collaborationMode` 计划预设。
- **目标**：首次发送的内容成为活动目标。目标会持久化到对应会话，可从 composer
  标记完成或清除；已有目标会在重新打开会话时恢复显示。
- **运行中发送**：“等待”使用 Pocket 的单条内存队列，并在 Codex 报告当前回合结束后
  调用 `turn/start`；手机锁屏或页面暂时断开时，服务端仍会继续跟踪这条等待消息。
  `Steer` 使用原生 `turn/steer` 和当前 `expectedTurnId`。重启 Pocket 服务会清空尚未开始
  的等待消息。

## 验证与排障

查看最近一次完整部署结果：

```powershell
Get-Content .\.data\setup-result.json
```

不启动窗口，只检查双击启动所使用的运行时：

```powershell
.\CodexPocket.cmd -Check
```

macOS/Linux 使用：

```sh
./CodexPocket.sh --check
```

查看 Codex Pocket 创建的防火墙规则：

```powershell
Get-NetFirewallRule -Group 'Codex Pocket' |
    Get-NetFirewallPortFilter |
    Format-Table Protocol, RemotePort
```

常用排障文件：

- `.data/setup-result.json`：环境检查、组件路径、版本和部署错误。
- `.data/runtime.json`：当前电脑验证过的 Python、Node.js 和 Codex 路径。
- `.data/firewall-result.json`：单独运行端口脚本时的规则结果。
- `.data/launcher.log`：macOS/Linux 桌面壳启动失败时的标准输出与错误。
- `.data/desktop.log`：本地服务和 Cloudflare Tunnel 启动日志。

如果部署提示找不到 Codex，请先安装 Codex CLI 或打开一次 Codex App。macOS/Linux
安装器会搜索常见版本管理器目录，但不会执行交互式 shell 配置。
如果公网链接迟迟不出现，先检查 `desktop.log`，再确认公司网络、代理或安全软件允许
上述三个出站端口。Quick Tunnel 适合个人临时访问，不适合作为长期生产服务。

## 开发与测试

```sh
npm test
npm run test:desktop
```

也可以仅启动本地查看器：

```sh
npm start
```

此时访问密钥保存在 `.data/access-token`，本地地址为
`http://127.0.0.1:4173/`。

## 安全边界

- Web 服务只监听 `127.0.0.1`，公网入口由临时 HTTPS 隧道提供。
- 每次桌面启动生成独立的高熵访问密钥，停止后立即失效。
- 手机消息使用 App Server 的 `thread/resume`、`turn/start` 和 `turn/steer` 创建或引导
  真实用户回合，并携带适用的模型、推理强度、协作模式与结构化 Skill 输入。新建会话
  时浏览器只提交同项目的已有会话 ID，完整工作目录不会返回浏览器。
- `status: active` 本身不会被当成 Codex Desktop 正在占用。Pocket 会先执行真实的 App
  Server 写入；只有 App Server 实际返回 `already has an active writer` 时，才以 `409`
  提示 Desktop writer 冲突并恢复输入草稿。Codex App 的本机工具桥仍只用于只读同步。
- App Server 管理的任务使用原生 `turn/interrupt` 中断；桌面持有的任务无法从 Web 端
  可靠中断，Pocket 会明确提示回到 Codex Desktop 操作。
- 同一会话一次只运行一个回合；运行期间可以 Steer 当前回合，或保存一条等待消息。
- 命令与文件修改仍遵守 Codex 的审批策略，不会默认绕过批准。
- 审批时会显示必要的命令预览；页面不返回命令原始输出、文件 diff、环境变量或
  完整工作目录。
- Skill 的磁盘路径仅用于本机 App Server 结构化输入，不会返回浏览器。
- 手机上传的图片经过文件签名校验后保存在本机 `.data/images/`，浏览器只会收到随机的
  不透明地址；读取图片仍需要有效的 Pocket 会话。图片在点击发送后才会作为
  `localImage` 输入交给所选模型，已发送图片会留在本机以便之后查看会话历史。发送前
  从 composer 移除图片时，Pocket 会删除对应的未发送文件。
- 页面会展示原始对话文本；如果会话本身含有密码或密钥，手机端也能看到。请把
  公网链接和访问密钥视为敏感信息。
- 当前手机端只处理命令与文件修改审批，其他交互式请求仍需回电脑处理。

依据：[OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)
