# opi-hub

opi-hub 为 [o-pi](https://github.com/Orion-zhen/o-pi) 提供独立的多设备管理入口。你可以在一个网页中查看各设备的会话和待处理审批，并打开对应的原生 o-pi 页面。

opi-hub 由独立项目维护。每台设备上的节点负责启动上游提供的 `opi-web`。本项目采用与 o-pi 相同的 [GNU AGPL v3](LICENSE)，详见[第三方声明](docs/third-party.md)。

## 安装

运行中心和节点需要 Node.js 24 或更新版本。从源码安装还需要 Git 和 Bun。

1. 在中心机器上安装并启动 opi-hub。

   ```bash
   git clone https://github.com/lzhao013-web/opi-hub.git
   cd opi-hub
   bun install --frozen-lockfile
   bun run init
   bun run hub
   ```

   打开 `http://127.0.0.1:19200`，使用初始化时显示的密码登录。如果节点和中心不在同一台设备上，先配置[其他设备访问](docs/installation.md#其他设备访问)。
2. 在目标设备安装本项目依赖，并[从 o-pi 源码构建 `opi-web`](docs/installation.md#获取-opi-web)。
3. 在中心网页添加设备，将下载的 `node.json` 保存到目标设备上的 `opi-hub` 目录。把配置中的 `command` 改成 `opi-web` 的实际路径，然后在该目录启动节点。

   ```bash
   bun run node --config ./node.json
   ```

分发包安装、完整节点配置和升级说明见[安装与启动](docs/installation.md)。

## 功能

- **会话管理**：按设备和工作区浏览会话，按需查找历史，远程新建会话或打开原生页面。
- **集中审批和通知**：在消息中心处理各设备的待处理交互，接收会话完成提醒。Windows 可从[节点系统通知](docs/usage.md#节点系统通知可选)切回已打开的会话。
- **计划任务**：预约一次性或周期任务，跟踪运行状态并查看结果。

更多说明见[文档目录](docs/README.md)。
