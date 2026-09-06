# 桌面与 Web 切换检查

检查日期：2026-09-06。下方历史测试记录不代表桌面 GUI 同任务切换已验收。

## 连接方式

桌面 App 的空闲任务也可能保留写入锁。单独启动第二个 stdio App Server 无法可靠接管。
macOS 桌面工具接口还会验证调用方签名；本实现不删除锁，不绕过签名验证。

共享模式通过 Codex 自带的 `app-server --listen ws://127.0.0.1:PORT` 建立持久后端。
桌面 App 通过 `CODEX_CLI_PATH` 启动 Pocket 生成的 stdio/WebSocket 本地代理，
Pocket 使用相同的回环 WebSocket 地址及 `CODEX_HOME`。当前 Codex Desktop 不会将
`CODEX_APP_SERVER_WS_URL` 当作本地桌面后端入口，因此不再依赖该环境变量启动桌面端。
该模式保持原任务 ID；旧的独立桌面进程尚未退出时，Web 会提示重新打开共享入口。
独立模式原有的显式续接副本功能只作为兼容入口，不等同于原任务切换。

共享服务会把 CLI 的真实路径和版本写入状态文件。创建后端时，显式 `CODEX_BIN` 优先；
macOS 在未显式指定时优先使用桌面包内的 CLI，确保 `codex_app` MCP 配置与桌面 App
使用同一版本，找不到时才使用 Homebrew CLI。旧状态与当前 CLI 不一致时，只有确认旧进程由
Pocket 管理且没有活动客户端才会优雅迁移；活动连接或无法确认进程归属时会保留旧进程并给出
明确提示，不会强制结束桌面任务。桌面启动环境变量已在本机 App 代码中核对；桌面启动开关
并非稳定的第三方集成承诺，App 升级后需复测。

迁移检查会区分 Pocket 自己的查看器进程和真实客户端：查看器必须属于当前 Pocket 项目，且
其本地 HTTP 端口仍有浏览器或隧道连接时才会阻塞迁移。已失去父进程且没有浏览器连接的孤立
查看器会在再次启动时先经过进程身份复核，再优雅退出；Codex Desktop、未知进程和无法确认
连接状态的进程不会被清理。

## 三系统入口

| 系统 | 入口 | 路径和进程处理 |
| --- | --- | --- |
| macOS | `CodexPocket.command` 或配置后的 Codex 系统图标 | 一次性安装自动接入后，Dock/Finder 启动也会通过动态代理连接同一后端 |
| Windows | `Install-CodexPocket.cmd`，之后 `CodexPocket.cmd` 或 Codex 系统图标 | 自动发现常规/商店安装路径，登记当前用户环境；原生代理通过 PowerShell/CIM 与 TCP 连接检测，商店 GUI 尚未实机验收 |
| Linux | `CodexPocket.sh` | `codex-desktop` 或 `CODEX_DESKTOP_PATH`；通过 ps/lsof 读取连接，缺少工具时报告待确认 |

先运行对应 Pocket 安装器。自定义桌面安装路径使用 `CODEX_DESKTOP_PATH`；不设置时会
检测常规位置，找不到就报告错误。Windows/macOS 在 Pocket 服务就绪后会自动请求已打开的
桌面程序正常退出并重开；Linux 或未配置自动接入的安装仍需使用 Pocket 的“连接桌面 App”。

### macOS 普通启动

首次运行 `Install-CodexPocket.command` 时自动登记当前用户的
`com.codexpocket.desktop-launch` LaunchAgent。它在登录时设置
`CODEX_CLI_PATH` 和 `CODEX_APP_SERVER_FORCE_CLI`，不打开 App，也不启动模型任务。
从 Dock/Finder 打开 App 时，动态代理读取共享后端状态，复用现有后端；后端已退出时
才重新启动。它不会修改 App 安装包。Pocket 窗口不必先运行。

原 GUI 启动环境保存在 `.data/desktop-launch-environment.json`。
`python3 install_desktop_launch.py --uninstall` 移除登记并恢复原值；用户之后自行改过的
环境变量不会被覆盖。该设置会影响新启动的 Codex 进程，已运行的 App 不会自动重启。
登记依赖当前 Pocket 目录与 Node 路径，移动目录或移除 Node 前应先取消登记。

实测 `node scripts/check-auto-launch-runtime.mjs`：在临时数据目录中，不开 Pocket
即可启动后端、重复打开并复用同一可写任务、后端退出后恢复。未调用模型。
系统启动环境和 LaunchAgent 已做本机读取校验；为保留当前任务，未强制重启正在使用的 App。

### Windows 普通启动

`Install-CodexPocket.cmd` 自动生成原生 `.exe` 代理，先通过原生进程调用验证 `--version`，
然后把两个启动变量写入当前用户 `HKCU\\Environment`，广播 `WM_SETTINGCHANGE` 让 Explorer
更新后续启动环境。无须管理员权限、手写脚本或额外编译 SDK。已有 Python/Node/Codex
前置依赖要求不变。安装期间已运行的 App 会在 Pocket 服务就绪后自动切换到共享连接。

原生代理将参数及标准输入输出直接转交子进程，绕开 App 不经过 shell 启动 `.cmd` 的问题，
并覆盖带空格、中文、引号和 shell 特殊字符的参数。二进制按源码版本命名，避免更新时覆盖
仍在运行的文件；代理只对 app-server 接入共享，其余 CLI 命令转交真实 Codex 可执行文件。
安装器优先发现桌面包内 CLI，npm 安装则解析到原生 vendor 可执行文件。

重复安装保留原环境备份；失败回滚，`python install_desktop_launch.py --uninstall` 恢复原值，
保留用户后来修改的设置。移动目录之前应先卸载登记，再在新目录运行安装器。
Windows 原生代理和共享协议测试由已有 Windows CI 矩阵执行；本机是 macOS，本轮没有
Windows/商店版 GUI 实测，也没有提交或触发远端 CI。WSL 桌面后端不属于这条原生 Windows 链路。

接口参考：[OpenAI App Server](https://learn.chatgpt.com/docs/app-server)。官方仍将 WebSocket
传输标记为实验性，桌面启动变量也可能随 App 版本变化；本实现会检测实际连接，不能承诺未来
版本无需兼容更新。

共享后端使用启动锁避免重复创建，地址和 CLI 身份原子写入；连接探测失败时，只有在确认旧
进程已退出后才复用原端口。端口被未知进程占用时会改用新的回环端口，避免误杀或覆盖其他
服务。
Pocket 控制器在创建查看器之前准备后端，因此 Windows 的查看器 `taskkill /T` 不会
把共享后端作为后代进程结束。仅关闭手机页面、Pocket 或隧道均不结束已开始的共享任务。
共享后端退出后，重新开启 Pocket 服务即可在原地址启动；查看器
自身断线只负责重连，不负责恢复已经崩溃的模型执行。

## 已修复与验证

- 两个客户端读取及修改同一任务，Web 断开后重新订阅，保留任务 ID 和运行状态。
- 旧历史、恢复响应和旧回合结束事件不覆盖新的运行状态；快速完成不再留下虚假忙碌。
- 桌面修改模型和任务设置后，Web 刷新同步；恢复过程中收到的新设置不被旧响应覆盖。
- 图片上传及失败发送在切换任务后仍归属原任务，文字草稿和阅读位置保持原有恢复行为。
- WebSocket 心跳、超时请求清理、并发初始化及恢复合并；关闭一个客户端不结束后端。
- 桌面健康检查等待实际 Codex 就绪；归档任务入口恢复，可从 Web 找回并恢复任务。
- 合并菜单的 Escape 处理，WebKit 点击滑块后也能关闭菜单并将焦点还给入口按钮。
- 模拟共享服务器覆盖运行中订阅、审批恢复、审批结果同步、Steer 和中断。
- 桌面 CLI 代理通过真实 stdio 子进程接入已运行的 WebSocket 后端，保持同一任务 ID。
- 真实 Codex 隔离测试覆盖共享读写、设置、重命名、断开重连；未调用模型生成或执行命令。

本次本机结果：`npm test` 的 Node 全量 216 项通过；Python 测试 66 项通过、3 项平台
专属测试跳过。真实共享协议检查通过，覆盖两个客户端读写同一任务、断线重连和关闭
Pocket 后后端继续运行。

Playwright UI 回归使用本机已安装的 Chrome 通过，覆盖桌面、手机、窄屏、深色模式、
二维码、断线恢复、权限及图片查看器。这些是本机模拟接口检查，不等同于真实公网 HTTPS 手机验收。

执行测试：

```sh
npm ci
npm test
python -m unittest discover -s test -p "test_*.py"
npm run test:ui
node scripts/check-shared-runtime.mjs
```

若 Playwright 自带的 Chromium 未安装，可使用已安装的 Chrome 执行
`PLAYWRIGHT_CHANNEL=chrome npm run test:ui`。

前三项覆盖源码和本地服务，UI 检查使用模拟接口。最后一项使用实际安装的 Codex 和
临时数据目录，不读写用户已有任务。CI 已配置 Windows/macOS/Linux、Node 20/24 及
Chromium/WebKit；本轮没有推送或执行远端 CI，不能将配置视为 Windows/Linux 实测。

## 使用边界

### 2026-09-06 MCP 配置修复

已在内置 CLI 上复现 `invalid transport in mcp_servers.codex_app`：桌面代理丢弃了
启动命令的 `-c mcp_servers.codex_app={command=...}`，后续任务请求只有
`mcp_servers.codex_app.enabled_tools`，无法构成合法的 MCP 配置。
代理现在使用 TOML 解析器保留启动配置，并作为 thread/start、thread/resume、thread/fork
的默认值合并；任务显式指定的设置仍优先。没有修改用户 config.toml 或禁用桌面插件。

`node scripts/check-desktop-config-runtime.mjs` 在 macOS 临时数据目录中先复现原错误，
再通过实际生成的代理和真实 WebSocket 后端验证创建、恢复和 Web 读取同一个任务。
不调用模型，不操作已有任务。已生成的本机代理入口也已更新；已运行的代理进程会在
Pocket 自动切换桌面 App 时重新加载。此验证不等同于桌面 GUI 或 Windows 真机验收。

- 桌面专属插件、工具及真实模型审批尚未完成共享模式的 GUI 验收。
- Windows/Linux 无测试设备；已完成路径、进程生命周期及共享协议复核，原生窗口、
  商店启动权限、X11/Wayland、真实休眠与唤醒仍需相应机器验收。
- 图片草稿不跨页面刷新；文字草稿限当前浏览器及域名。Pocket 的“等待”仍是内存队列，
  关闭 Pocket 会丢失尚未开始的等待消息；已经送入共享后端的执行不受此影响。
- 网络中断导致发送结果不明时不自动重发，保留草稿供核对，避免重复执行用户命令。
- Quick Tunnel 重建可能换域名，需要重新扫码；电脑必须保持开机联网。需要长期固定
  入口时应配置固定域名隧道，临时域名不能保证随时可达。

诊断文件：`.data/shared-server.json`、`.data/shared-codex.log`、`.data/desktop.log`。
`/api/health` 的 `connectionMode` 为 `shared` 表示 Pocket 已选择共享连接，`codex` 为
`ready` 表示连接初始化完成；这些字段不证明当前桌面窗口也已迁移至共享连接。桌面窗口
新增 `desktopConnection` 字段在 health/bootstrap/SSE/sync 中保持一致，仅确认桌面主进程或其
后代进程连接了共享端口后才显示“已共享”。发现桌面直接启动独立 CLI 时显示“正在切换”，
无法读取进程或连接时显示“待确认”。不会根据配置文件或 Pocket 的连接推断桌面已共享。
