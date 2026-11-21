# opi-hub

opi-hub 为 [o-pi](https://github.com/Orion-zhen/o-pi) 提供独立的多设备管理入口。你可以在一个网页中查看各设备的会话和待处理审批，并打开对应的原生 o-pi 页面。

opi-hub 由独立项目维护。每台设备上的节点负责启动上游提供的 `opi-web`。本项目采用与 o-pi 相同的 [GNU AGPL v3](LICENSE)，详见[第三方声明](docs/third-party.md)。

## 快速启动

运行中心和节点需要 Node.js 24 或更新版本。从源码安装还需要 Git 和 Bun。

1. 在中心机器上安装并启动 opi-hub。

   ```bash
   git clone https://github.com/lzhao013-web/opi-hub.git
   cd opi-hub
   bun install --frozen-lockfile
   bun run init
   bun run hub
   ```

   默认只监听本机。打开 `http://127.0.0.1:19200`，用 `init` 显示的密码登录。按需调整上面的命令：

   - **数据和密码**：`init` 和 `hub` 都接受 `--data <目录>`，默认 `./data`。自定义时，两条命令要指向同一目录。若要自定中心密码，在首次 `init` 前设置环境变量 `OPI_HUB_PASSWORD`（至少 12 个字符）。
   - **跨设备访问**：`--host` 指定监听地址（默认 `127.0.0.1`），`--port` 指定端口（默认 `19200`），`--public-url` 指定浏览器和节点实际访问的入口，不带子路径。例如在可信内网运行 `bun run hub --host 0.0.0.0 --port 19200 --public-url http://192.168.1.10:19200`，将示例 IP 换成中心机器的地址，之后用该地址登录。
   - **HTTPS**：由中心直接提供 HTTPS 时，给 `hub` 同时传入 `--cert <证书文件>` 和 `--key <私钥文件>`。若设置了 `--public-url`，也要使用 `https://` 地址。
2. 在目标设备安装本项目依赖，并[从 o-pi 源码构建 `opi-web`](docs/installation.md#获取-opi-web)。
3. 在中心网页添加设备，将下载的 `node.json` 保存到目标设备的 `opi-hub` 目录。保留生成的 `hub`（中心地址）和 `token`（设备凭据），把 `command` 数组的第一项改成 `opi-web` 的实际路径，其余项可填后端参数。可选的 `cwd` 指定后端初始工作目录，默认是运行账号的主目录。在 `opi-hub` 目录启动节点，`--config` 必填：

   ```bash
   bun run node --config ./node.json
   ```

   节点默认检测系统通知。要接收提醒，在“消息中心 → 通知”把本机节点选为接收端。以下选项按需启用：

   - **关闭节点通知**：在 `node.json` 顶层设 `"notifications": false`。下列切页和审批选项都需要节点通知开启。
   - **Windows 切回会话**：在 `node.json` 顶层设 `"windowsFocus": true`，启动命令不用改。也可给启动命令追加 `--windows-focus`。绑定接收端后刷新一次会话页，之后点击新的完成通知即可在支持 `--focus` 的默认浏览器中切回匹配页。
   - **在通知里直接审批**：Windows 追加 `--windows-approvals`，Linux 桌面追加 `--linux-approvals`（需支持动作按钮的 `notify-send`）。例如 `bun run node --config ./node.json --windows-approvals` 可与配置中的 `windowsFocus` 同时使用。两个平台的审批开关不能混用。

   修改 `node.json` 后，等正在运行的任务结束，再重启节点使配置生效。

三个命令都支持 `-h` 或 `--help`，例如 `bun run node --help`。分发包和升级步骤见[安装与启动](docs/installation.md)。

## 功能

- **会话管理**：按设备和工作区浏览会话，按需查找历史，远程新建会话或打开原生页面。
- **集中审批和通知**：在消息中心处理各设备的待处理交互，接收会话完成提醒。Windows 可从[节点系统通知](docs/usage.md#节点系统通知可选)切回已打开的会话。
- **计划任务**：预约一次性或周期任务，跟踪运行状态并查看结果。

更多说明见[文档目录](docs/README.md)。
