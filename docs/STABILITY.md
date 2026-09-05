# 稳定性检查记录

检查日期：2026-09-05。

## 本轮修复

| 问题 | 修复后的行为 |
| --- | --- |
| Quick Tunnel 官方不支持 SSE，但网页依赖 SSE | Quick Tunnel 地址使用 HTTPS 快照同步；其他地址的 SSE 不可用时自动切换，共用消息、审批及队列事件处理 |
| 单个会话读取超时拖住其他会话 | 每个会话独立同步，同一会话只保留一个正在进行的轮询；页面请求复用同时进行的读取 |
| 没有手机连接时仍持续读取完整会话列表 | 就绪且没有订阅、没有等待消息时暂停数据读取，15 秒检查一次；新订阅立即唤醒 |
| Codex 持续失败时频繁重复启动 | 后台轮询失败后逐步退避，最长 30 秒；请求与事件流仍可重新触发连接 |
| Cloudflared 退出时一并终止本地 Codex | 单独重建隧道，保留本地服务与访问密钥；网络持续失败时继续退避重试 |
| 恢复隧道时旧进程日志污染新链接 | 日志与具体进程绑定，旧进程不能覆盖当前连接信息 |
| 端口分配失败后启动状态卡死 | 端口分配进入统一清理路径，失败后可以再次启动、停止 |
| 本机健康检查被系统代理转发 | 仅回环健康检查显式绕过代理；组件下载仍遵循用户网络配置 |
| 首次无界面启动丢失参数、安装图形库 | 启动器转交参数，无界面模式跳过桌面后端安装 |
| macOS Python 3.8/3.9 选择无法构建的 PyObjC 12 | 使用条件依赖约束到 PyObjC 11 系列；较新 Python 不受该约束影响 |
| Mac 只装 ChatGPT.app 时找不到内置 Codex | 增加此应用包内的 Codex 可执行文件候选 |
| Windows 找到 Node 后，Codex 命令包装器仍找不到 node.exe | 将已验证的 Node 目录加入子进程 PATH；跳过无法执行的 Codex 候选 |
| Windows ARM64 请求不存在的 Cloudflared 文件 | 改用官方 x64 包，需要 Windows 11 兼容运行支持 |
| 保存的运行时路径覆盖用户显式环境变量 | 环境变量优先，保存配置和自动发现作为后续候选 |
| HTTP 200 但 JSON 无效时误显示发送成功 | 显示请求错误并保留草稿，交付状态不明确时不自动重发 |
| 桌面状态未改变也不断重写字段 | 状态相同时跳过渲染，保留文本选择 |
| IPv6 回环链接缺少方括号 | 正确生成 `http://[::1]:端口/` |

## 代码精简

- 删除旧 Tk 窗口、手绘控件、工具提示和仅服务于 Tk 的 DPI/坐标逻辑。
  `codex_pocket.py` 的图形入口统一调用现有 WebView 桌面界面，保留无界面入口。
  该文件从 1,892 行减至 756 行。
- 合并子进程创建、登记和标准输出/错误流读取，减少两套启动实现的差异。
- 合并桌面后端探测与安装流程，去掉重复安装。
- 删除现代浏览器必备 API 的兼容回退；保留网络超时、身份验证、图片大小限制、
  发送去重状态、子进程清理和过期响应隔离。这些检查有实际故障场景。

## 已完成的本机验证

环境：Apple Silicon Mac，Python 3.9.6，Cocoa；Node 24.19.0 和 26.7.0。

- Node：125 项测试通过，包含真实 stdio 初始化、子进程退出后的恢复、请求超时、
  HTTP 身份验证、SSE 心跳、断开重连，以及慢会话与正常会话同时订阅。
- Python：51 项中 48 项通过，3 项仅限 Windows 的测试在 Mac 上跳过。
- macOS 启动环境检查与已安装依赖一致性检查通过；重新解析依赖选中 PyObjC 11.1。
- Chrome 与 WebKit：手机 390px、窄屏 320px、桌面、深色模式、草稿恢复、断网编辑、
  流式输出时保持阅读位置、软键盘尺寸、菜单、单图/多图查看器通过。
- 官方 Cloudflared 2026.8.3 发行资产已核对，Windows 没有 ARM64 原生二进制。
- 已用独立的真实 Codex/Cloudflared 服务验证：主动结束测试隧道后自动恢复，
  本地服务进程和访问密钥保持不变，最后正常清理测试进程。
- 模拟会话通过真实 Quick Tunnel 完成了带身份验证的公网 HTTPS 同步；真实会话的
  公网烟测被自动审批拒绝，因此公网验证只使用虚构数据。
- 新旧服务通过能力字段协商同步通道，尚未重启的旧服务不会被新网页请求不存在的接口。

可重复执行：

```sh
npm test
python -m unittest discover -s test -p "test_*.py"
npm run test:ui
```

`scripts/check-service.py` 是额外的实网检查：使用虚构 Codex 会话与独立数据目录，
通过真实 Cloudflare HTTPS 验证同步，再终止自己的测试隧道并检查恢复，最后停止
测试进程。它不会读取用户 Codex 账户或会话，也不会停止已有 Pocket 服务。

## 尚需验收

| 环境 | 当前覆盖 | 仍需验证 |
| --- | --- | --- |
| macOS Apple Silicon | 真实运行时、Cocoa 导入、Chrome/WebKit 回归 | 长时间锁屏、系统休眠/唤醒、真实手机跨网络切换 |
| macOS Intel | 发行资产与启动路径检查、共享逻辑测试 | Intel 设备上的安装及桌面窗口 |
| Windows x64 | PowerShell/路径逻辑检查、原生 CI 配置 | Windows 实际执行 CI、WebView2 窗口、剪贴板、隧道与进程回收 |
| Windows ARM64 | 使用存在的官方 x64 下载资产 | Windows 11 ARM 的整套安装及兼容运行 |
| Linux x64/ARM64 | 无界面路径测试、发行资产核对、原生 CI 配置 | 实际执行 CI、GTK/Qt、X11/Wayland、系统服务及网络切换 |

CI 配置已经加入工作区，本轮没有推送仓库或触发远端 Actions。因此它是待执行的
验收配置，不能作为 Windows/Linux 已实测通过的证据。手机尺寸模拟与 WebKit 回归也
不能替代真实 iPhone/Android 的键盘、后台冻结及蜂窝网络测试。

用户未提供 Windows/Linux 测试设备，本轮按代码复核、共享逻辑回归与官方资料核验
完成这两个系统的复核，不将其表述为真机验收通过。

## 官方资料

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)：不支持 SSE；无 SLA/可用率保证；定位为开发与测试。
- [Cloudflared 官方发行包](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.3)：核对各平台及架构资产。
- [pywebview 安装要求](https://pywebview.flowrl.com/guide/installation.html)：Windows WebView2、macOS PyObjC，以及 Linux GTK/Qt 后端要求。
- [Node.js Windows 进程启动](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)：`.cmd`/`.bat` 需要命令解释器；含空格的脚本路径必须引用。

## 产品边界

- Quick Tunnel 是临时域名，隧道重建后无法承诺沿用原手机地址。需要固定入口时，应
  使用用户自己配置的固定域名/受管隧道；本轮未更改用户的 Cloudflare 账户配置。
- Mac Codex App 的桌面接口可能要求签名身份。Pocket 的 App Server 连接恢复不代表
  可以接管桌面持有的任务。此限制沿用 README 说明，没有绕过签名校验。
- Codex 进程本身退出后可以重新建立连接，但不能保证已中断的执行自动继续。消息交付
  不明确时保留草稿、由用户核对，避免自动重复执行命令。
