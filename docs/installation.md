# 安装与启动

## 环境

- **Node.js 24 或更新版本**用于运行中心和节点。
- **Git 和 Bun** 用于克隆源码、安装依赖和构建。`bun run hub` 和 `bun run node` 会显式调用 Node.js。使用分发包时，只需为 opi-hub 安装 Node.js。
- 被管理设备需要上游的 `opi-web`，见[获取 opi-web](#获取-opi-web)。
- 节点应以实际使用者账号运行，继承该账号的环境和 `~/.pi` 配置，不自动切换账户或提权。

## 启动中心

```bash
git clone https://github.com/lzhao013-web/opi-hub.git
cd opi-hub
bun install --frozen-lockfile
bun run init
bun run hub
```

`init` 创建 `data/hub.json` 并显示随机初始密码。请保存在密码管理器中。也可以在初始化前通过环境变量 `OPI_HUB_PASSWORD` 指定至少 12 个字符的密码。已有数据不会被覆盖。

打开 `http://127.0.0.1:19200`，使用中心密码登录。

### 其他设备访问

指定实际访问地址和监听地址。例如，中心的局域网或 Tailscale IP 为 `100.100.1.2`：

```bash
bun run hub --host 0.0.0.0 --port 19200 --public-url http://100.100.1.2:19200
```

`--public-url` 是所有浏览器和节点使用的统一入口。可以使用 IP 或域名，不能包含子路径。服务校验 Host 和 Origin，访问地址必须与配置一致。按新地址打开中心并登录，再添加设备。签发的节点配置会使用该入口。

HTTP 仅用于本机或受保护的可信内网。应用层不会加密 HTTP 中的密码、凭据和会话。公网必须使用 [HTTPS](deployment.md#https)。

## 获取 opi-web

`opi-web` 由上游 o-pi 提供。构建需要 Git 和 Bun 1.4.0 或更新版本。以下命令在目标设备上从上游源码构建 Web 版，步骤来自 [o-pi 安装与启动](https://github.com/Orion-zhen/o-pi/blob/main/docs/guides/getting-started.md#web)。

```bash
git clone https://github.com/Orion-zhen/o-pi.git
cd o-pi
bun install --no-save
bun run build:web
```

构建产物位于 o-pi 仓库的 `dist/web/opi-web`，Windows 下为 `dist/web/opi-web.exe`。可以将程序放到目标设备上的固定位置，并把绝对路径填入节点配置的 `command`。节点会自动启动和停止 `opi-web`，无需提前运行。同一台设备已有与本项目兼容的 Web 版产物时，可以直接指定该文件。

## 添加设备

1. 在管理界面点击“添加设备”，填写名称。
2. 下载节点配置 `node.json`。设备凭据仅在创建时显示。
3. 在目标设备克隆 opi-hub 并运行 `bun install --frozen-lockfile`，或解压[分发包](#使用分发包)。按[上面的步骤](#获取-opi-web)准备 `opi-web`。
4. 将下载配置中的 `command` 改为该设备上的程序路径：

   ```json
   {
     "hub": "http://100.100.1.2:19200",
     "token": "管理界面生成的完整设备凭据",
     "command": ["F:/apps/opi-web.exe"],
     "cwd": "F:/projects"
   }
   ```

   Linux/macOS 可填写如 `["/opt/opi/opi-web"]`。`command` 是程序及可选前置参数的非空数组，不经过 Shell。推荐所有文件路径使用绝对路径。裸程序名从 PATH 查找，相对程序路径和 `cwd` 按启动节点时的当前目录解析。

   `cwd` 是后端初始目录，可省略，默认当前运行账号的主目录。之后可在任意有权限的已有目录新建会话。节点固定追加回环监听、自动端口和初始目录参数，不需要配置端口。

   节点默认启用系统通知检测，设置 `"notifications": false` 可关闭。若 Windows 节点用作[通知接收端](usage.md#节点系统通知可选)，可在配置顶层加入 `"windowsFocus": true`，让完成通知优先打开已有会话标签页。配置仅在启动时读取，修改后请等托管任务结束，再用原命令重启节点。

5. 在本项目目录启动节点。使用分发包时，将 `bun run node` 换成 `node dist/cli.js node`。

   ```bash
   bun run node --config /path/to/node.json
   ```

6. 节点会自动启动无窗口后端、分配回环端口并上报进程状态。中心显示“在线”后，点击“打开 o-pi”。

每个节点只管理自己启动的一份后端，多目录会话共用该后端，不扫描或接管外部进程。恢复历史前应先停止仍在写入该会话的手动进程，避免多进程并发写同一文件。同一设备凭据不要并行运行多个节点，后连接的节点会替换旧连接，旧节点随之退出并停止其托管任务。

## 使用分发包

解压后保留完整的 `dist/`，在解压目录中使用 Node.js 运行。中心执行前两条命令，受管理设备按上文配置后执行第三条。已有中心数据时跳过 `init`。

```bash
node dist/cli.js init
node dist/cli.js hub
node dist/cli.js node --config /path/to/node.json
```

运行分发包无需安装 Bun 或 opi-hub 的项目依赖，受管理设备仍需单独准备 `opi-web`。

## 升级

1. 等待设备上的托管任务结束。重启节点会停止它托管的 `opi-web`，中断运行中的任务。
2. 停止中心，备份整个 `data/` 目录。见[备份要求](deployment.md#安全边界)。
3. 先更新并重启中心，再更新并重启各节点。旧节点进程需要重启才能使用新功能。

如果旧版节点配置使用 `target`，删除该字段并添加 `command`，保留原有的 `hub` 和 `token`。新版会拒绝带 `target` 的配置。
