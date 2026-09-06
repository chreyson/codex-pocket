# Codex Pocket

Codex Pocket 是一个最小的手机端 Codex 会话遥控器。电脑端读取 Codex App 使用的
同一份会话数据，再通过 Cloudflare Quick Tunnel 提供临时 HTTPS 入口。手机可以
查看持续更新的回复、思考、工具活动和对话图片，发送文字或图片消息，中断或继续任务，
并回答结构化问题、处理命令、文件与权限审批，以及 MCP 信息补充请求。

Web composer 会直接读取当前 Codex 账户和项目的能力目录，支持选择模型、该模型实际
支持的推理强度、一个或多个 Skill，以及“执行 / 计划 / 目标”工作模式。模型和强度
不会在 Pocket 中维护静态名单，因此 Codex 升级或账户权限变化后会自动同步。

Codex App Server 通过本机 stdio 或回环 WebSocket 连接，不会直接暴露到公网；本地 Web 服务也
只监听 `127.0.0.1`。

## 安装与启动

### 通用前置环境

- Python 3.8 或更高版本。
- Node.js 20 或更高版本，推荐使用 Node.js 22/24 LTS。
- Codex App 或 Codex CLI；先打开或运行一次，确认 API 登录配置可正常使用。
- 项目目录必须对当前用户可写。下载或克隆后请保留整个目录，不要只复制启动文件。

安装器会自动准备 Python 桌面依赖和当前系统、处理器架构对应的 `cloudflared`。首次安装
需要访问 Python 包索引和 Cloudflare 的 GitHub Release。

### Windows

支持 Windows 10/11。系统还需要 Microsoft Edge WebView2 Runtime，通常已经预装；
缺失时安装 [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
ARM64 设备需要 Windows 11 的 x64 兼容运行支持；Cloudflare 尚未提供 Windows ARM64
原生包，安装器会使用官方 x64 包。

首次使用直接双击 `Install-CodexPocket.cmd`。安装窗口会自动切换到项目目录、检查环境、
准备依赖、登记桌面自动共享接入并打开 Codex Pocket，不需要手动设置环境变量。
以后双击 `CodexPocket.cmd` 即可；Codex App 也可以从开始菜单直接打开。
安装器使用 Windows 自带的 .NET Framework 4 编译原生代理，不需要另外安装编译 SDK。

普通双击不需要管理员权限，也不会修改防火墙。如果公司安全策略阻止 Cloudflare
Tunnel，可右键安装器并选择“以管理员身份运行”；此时只配置三条出站规则。

### macOS

支持 Intel 与 Apple Silicon Mac。首次使用双击 `Install-CodexPocket.command`；如果
macOS 首次拦截脚本，可在 Finder 中右键该文件并选择“打开”。安装器会在项目内创建
独立的 `.venv`，安装 Cocoa 桌面后端，并选择正确架构的 `cloudflared`。以后双击
`CodexPocket.command` 启动。安装器同时登记当前用户的自动共享接入，之后从 Dock/Finder
打开 Codex App 会自动连接同一后端，不要求先打开 Pocket。

如果第三方 ZIP 工具移除了 Unix 执行权限，可在项目目录一次性运行
`chmod +x *.command *.sh`，之后仍按双击流程使用。

从 Finder 启动时通常不会加载 `.zshrc`。安装器会额外检查 Homebrew、MacPorts、Volta、
nvm、fnm、asdf、mise、Bun 和常见用户级目录，因此这些位置中的 Node/Codex 不要求
额外加入 Finder 的 `PATH`。

部分 macOS Codex App 版本会对桌面通信接口校验调用进程的代码签名，拒绝 Pocket 的
Node 进程，日志表现为 `missing-code-signing-identity`。这种情况下，桌面持有会话的
原生续写回退不可用；设置接口路径无法解决。可使用由 Pocket 管理的任务，或在桌面
释放会话后通过 App Server 接续。手机端不能保证接管桌面正在运行的任务。

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

首次安装也可以运行 `./Install-CodexPocket.sh --headless`。无界面模式不会安装 GTK、Qt
或 Cocoa 依赖；`./CodexPocket.sh --headless --check` 只检查环境。

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
  -CodexPath "D:\Tools\Codex\codex.exe" `
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
| 出站 | TCP 443 | Quick Tunnel 建立与 HTTPS 控制请求 |

不创建 Windows 入站规则，不需要在路由器上做端口映射，也不需要公网 IP。手机的
HTTPS 请求先到 Cloudflare，再沿电脑主动建立的出站隧道返回本机服务。本地查看器
使用随机端口并仅监听 `127.0.0.1`，不会监听 `0.0.0.0`。

若之后需要补充或刷新规则，右键 `Install-CodexPocket.cmd` 并选择“以管理员身份运行”
即可；重复部署是幂等的，不会创建重复规则。规则结果也会写入部署结果文件。

macOS/Linux 安装器不修改系统防火墙。这些系统只需允许 `cloudflared` 主动访问下表中的
远端端口，不需要开放入站端口。

## 使用方法

1. 打开 Codex Pocket，点击“开启服务”。
2. 点击“通过二维码连接”，用手机相机扫描弹窗中的二维码，在浏览器中打开即可自动登录；也可以
   点击二维码右上角的复制图标，将二维码图片粘贴到其他应用。原有访问地址和密钥仍可手动使用。
3. 选择会话，在底部选择模型、推理强度、模式和所需 Skill，然后发送任务。打开会话会
   直接定位到最新消息。每条用户命令及其后续完整响应组成一个回合，旧回合默认折叠且
   可按需展开。项目标题右侧的 `+` 可在同一项目
   中新建会话。
4. 任务运行时输入框仍可编辑：“等待”会在当前回合完成后自动发送下一条消息，`Steer`
   会把消息立即送入当前回合；右侧独立的停止按钮用于中断。每个会话最多保留一条等待
   消息。需要运行命令或修改文件时，可在手机上允许或拒绝常见审批。
5. 点击输入框左侧的图片按钮可从手机相册或文件中选择图片；对话中的图片可点击全屏
   查看。
6. 使用结束后点击“停止服务”，或关闭桌面窗口。

窗口会停止本地查看器和公网隧道；独立模式同时停止自己的 Codex App Server，
共享模式保留桌面和 Web 共用的后端及已开始的任务。每次开启都会生成新的
访问密钥，Quick Tunnel 的公网域名也可能变化。桌面控制器只允许一个实例运行，
重复双击不会启动第二套端口和隧道。

二维码在桌面窗口本地生成，不调用第三方二维码服务。二维码和连接链接都包含本次
访问密钥，请勿公开分享。登录后网页会清除地址栏中的密钥；同一浏览器在地址和密钥
不变时可复用登录状态。服务停止后窗口会清除二维码，重启或隧道更换域名后需重新扫码。

运行中的 Cloudflared 进程意外退出后，控制器会单独恢复隧道，保留本地 Codex 服务、
任务和访问密钥。恢复失败时逐步延长重试间隔，最长 30 秒；点击“取消启动”可停止。
Quick Tunnel 重建可能产生新域名，需要从桌面窗口获取新链接。普通网络中断且进程仍在
运行时，由 Cloudflared 自身重连。电脑休眠或关机期间无法继续提供远程访问。

### 手机接续工作

要在桌面和 Web 中继续**同一个任务**，两个客户端必须连接到同一个后端：

1. 首次运行安装器；Windows/macOS 会自动完成共享接入登记。安装前已打开的 Codex App 会在 Pocket 服务就绪后自动切换到共享连接。
2. 之后可以先开 Codex App，也可以先开 Pocket。开启 Pocket 服务后，用手机扫码继续任务。
3. 连接状态旁的问号显示实际检测结果；如果 Codex App 先于 Pocket 启动，Windows/macOS 都会在服务就绪后自动请求 App 正常退出并重开，使它接入共享后端。

Pocket 会保存 `.data/shared-server.json`，但这个文件只代表后端配置，不能证明桌面已接入。
Windows/macOS 的安装器登记对新启动的 App 生效；Pocket 服务会自动切换此前已经运行的 App。
Windows 会通知 Explorer 刷新当前用户环境；企业策略阻止登记时，安装器报告失败，不会显示安装成功。
Linux 尚未登记系统图标的自动接入，需要使用 Pocket 的“连接桌面 App”。
Pocket 会为桌面 App 生成本地 CLI 代理，通过 `CODEX_CLI_PATH` 把桌面 stdio 协议转发到现有共享后端；
它不依赖桌面 App 不识别的 `CODEX_APP_SERVER_WS_URL`，也不绕过 macOS 的本地 pipe 签名校验。
非标准安装可通过 `CODEX_DESKTOP_PATH` 指定桌面程序。Linux 需要实际安装支持共享连接
的桌面客户端，Pocket 安装器不安装 Codex 桌面 App。

如果桌面曾提示 `invalid transport in mcp_servers.codex_app`，先正常退出桌面 App，再重新
启动 Pocket。Pocket 会优先选择桌面包内置的 Codex CLI，并检查共享状态中的 CLI 路径与版本；
发现旧后端仍有 Web/桌面连接时会停止迁移并提示，不会强制结束正在执行的任务。

共享连接断开时只重连原地址，不另起一个争抢任务的独立进程。关闭 Pocket 不停止共享
后端；电脑重启后再次使用共享入口即可恢复连接，之前被系统中断的模型执行不会自动重放。
详细覆盖范围和已知限制见 [跨端切换检查](docs/cross-platform-switching.md)。

- 文字草稿按会话保存在当前浏览器，切换会话、刷新或锁屏返回后可继续编辑；成功收到
  服务端的发送确认后清除对应草稿。最多保留 30 个会话的草稿，恢复时忽略超过 7 天的内容。
  图片附件在会话间切换时保留，上传完成后仍归属原会话，但不跨页面刷新保存。
  浏览器禁用存储时，文字草稿只能保留在当前页面。
- 重新打开同一访问地址会恢复上次会话；刷新按钮原地同步消息和能力目录，保留当前
  输入及附件。网络恢复、页面重新可见时重新建立事件流，服务器每 15 秒发送保活消息。
- Cloudflare 官方明确表示 Quick Tunnel 不支持 SSE，因此 `trycloudflare.com` 地址
  使用普通 HTTPS 同步，任务运行时约每 0.5 秒刷新一次，空闲时约每 1.5 秒刷新一次
  （另加请求耗时）。其他地址优先使用 SSE，连接失败或持续没有事件时自动转入 HTTPS
  同步。两种通道共用消息更新逻辑，切换时保留草稿和阅读位置。
- 断网时仍可编辑文字，会话页显示连接状态，恢复连接后不会自动发送草稿。
  若发送时没有收到确认，先核对会话最新消息再决定是否重试。
- 手机回车换行，发送按钮提交；外接键盘也可使用 Command/Ctrl + Enter。桌面键盘仍
  支持 Enter 发送、Shift + Enter 换行，中文输入法选字不会触发发送。
- 向上阅读历史消息时保持当前位置，可用向下箭头返回最新消息。键盘弹出时按可见
  视口调整输入区；系统开启减少动态效果时沿用静态交互。
- 工具活动默认显示一行操作摘要；点击摘要可以展开细节。保留当前正在思考的状态，隐藏历史思考记录。
  展开状态在实时更新时保留。工具失败在细节内标记，审批请求和任务错误仍独立显示。
- 输入框左下角的 `+` 打开图片、工作模式与 Skills 选项；模型和推理强度位于右下角。
  权限菜单沿用 Codex App 的中文名称：“请求批准”“帮我批准”“完全访问权限”。
  切换后立即保存到当前任务，运行中和有等待消息时不能更改。不可用的模式会禁用；
  未能读取当前任务权限时显示“自定义”，不会猜测或自动放宽权限。

草稿保存在浏览器对应域名的本地存储中；Quick Tunnel 更换域名、清理站点数据或换用
另一台手机后，无法读取原域名的草稿。远程继续工作仍要求电脑保持运行和联网。

### Composer 选项

- **模型与推理强度**：模型来自 App Server 的 `model/list`；切换模型后，只显示该
  模型支持的强度。选择会保存在当前浏览器中，并在服务端再次校验。
  配置或当前任务明确选用的隐藏模型也会保留，例如 `gpt-6-astra`；其余隐藏模型仍不展示。
  出现在目录中不等于账户已获得调用权限，实际可用性仍由 Codex 服务端决定。
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

浏览器回归测试使用隔离的静态服务和模拟 API，不会发送真实 Codex 任务：

```sh
npm ci
npx playwright install chromium webkit
npm run test:ui
```

设置 `PLAYWRIGHT_BROWSER=webkit` 可使用 WebKit 引擎；本机已有 Chrome 时，也可设置
`PLAYWRIGHT_CHANNEL=chrome`。截图输出到 `.data/qa/`。

`.github/workflows/stability.yml` 覆盖 Windows/Linux/macOS 的运行时测试、桌面后端导入，
以及 Chromium/WebKit 的移动端回归。当前检查结果与真机验证边界见
[稳定性检查记录](docs/STABILITY.md)。

前端浏览器回归脚本为 `scripts/check-mobile.mjs`，需要可用的 Playwright。启动本地
查看器后运行 `node scripts/check-mobile.mjs`；可用 `PLAYWRIGHT_MODULE` 指定模块路径，
`PLAYWRIGHT_CHANNEL=chrome` 使用本机 Chrome，`POCKET_TEST_URL` 指定本地服务地址。
测试使用模拟会话，不向真实 Codex 任务发送消息，截图保存在 `.data/qa/`。

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
  Server 写入；如果 App Server 返回 `already has an active writer`，Pocket 会重新读取
  Desktop 快照，确认任务空闲后通过 Codex App 原生工具续写同一会话。模型、推理强度
  和 Skill 会一并转交；图片与计划模式目前需要移除或切回执行模式，或者先退出 Desktop。
- App Server 管理的任务使用原生 `turn/interrupt` 中断；桌面持有的任务无法从 Web 端
  可靠中断，Pocket 会明确提示回到 Codex Desktop 操作。
- 同一会话一次只运行一个回合；运行期间可以 Steer 当前回合，或保存一条等待消息。
- 命令与文件修改仍遵守 Codex 的审批策略，不会默认绕过批准。
- 审批时可展开必要的命令预览；权限申请会列出所请求的读写路径及网络范围，
  便于判断授权范围。命令预览会隐藏密钥，不返回环境变量和命令原始输出。
- Skill 的磁盘路径仅用于本机 App Server 结构化输入，不会返回浏览器。
- 手机上传的图片经过文件签名校验后保存在本机 `.data/images/`，浏览器只会收到随机的
  不透明地址；读取图片仍需要有效的 Pocket 会话。图片在点击发送后才会作为
  `localImage` 输入交给所选模型，已发送图片会留在本机以便之后查看会话历史。发送前
  从 composer 移除图片时，Pocket 会删除对应的未发送文件。
- 页面会展示原始对话文本；如果会话本身含有密码或密钥，手机端也能看到。请把
  公网链接和访问密钥视为敏感信息。
- Pocket 自己的 App Server 请求支持结构化提问（单选、自由回答、多题、秘密字段）、
  命令与文件审批、按本轮或会话授予权限，以及 MCP 标准表单和 URL 授权。
  审批按服务端提供的选项展示；命令规则、网络规则和权限范围由服务端取回，
  浏览器不能扩大范围。表单未提交时不会因流式更新、断线重连或切换会话丢失输入；
  输入仅保存在当前页面内存，刷新页面会清空，秘密字段提交后立即清除。
- 待处理请求通过 SSE 和轮询同步。重复提交和失效请求会被拒绝，收到 Codex 的
  `serverRequest/resolved` 通知后移除。MCP 扩展表单若包含未支持的字段或约束，
  仅提供拒绝、取消，不能绕过验证接受。
- **桌面持有的请求仍有接口限制**：当前原生桥接仅接入读取会话和发送消息，
  没有桌面待处理请求的枚举、回复接口。网页不能批准或回答 Codex Desktop
  进程持有的请求；这些请求仍需在原 App 内处理。上述网页功能适用于 Pocket
  的 App Server 收到的请求，不代表已实现跨进程审批同步。

依据：[OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)
