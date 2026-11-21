# 开发与发布

## 构建与验证

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bunx playwright install chromium --only-shell
bun run test:browser
bun run build
```

安装依赖时会自动准备 Markdown 浏览器模块，构建时也会重新准备并打包到 `dist/web/`，无需访问 CDN。若安装时跳过了生命周期脚本，先运行 `node scripts/prepare-web.ts`。

## 验证真实 o-pi Web

运行定向无头测试时，用 `OPI_WEB_BINARY` 指定[已构建的 `opi-web`](installation.md#获取-opi-web)。测试使用临时工作区和配置，不读取用户模型凭据，也不访问外部模型。

```bash
# Bash
OPI_WEB_BINARY=/path/to/opi-web bun run test:native -- tests/native/schedules.spec.ts
```

```powershell
$env:OPI_WEB_BINARY = 'F:/o-pi/dist/web/opi-web.exe'
bun run test:native -- tests/native/schedules.spec.ts
```

测试覆盖认证、设备注册和撤销、双设备隔离、HTTP/WebSocket 转发、附件请求体、流式文件、Range、中心重启及桌面/手机布局。计划任务另覆盖时区、夏令时、间隔锚点、跨午夜、窗口截止、持久化与去重、离线错过、不重入、集中审批、取消和超时。定向界面测试使用 `bun run test:browser -- tests/browser/schedules.spec.ts tests/browser/interval.spec.ts`。

真实二进制由节点自动托管，可按需选择原生测试文件验证 GUI 加载、远程创建、集中交互或后端重启。`tests/native/timeout.spec.ts` 会实际保持审批超过 30 秒，再确认并验证响应正常返回。预约测试使用本机模拟模型，真实 SDK 创建会话、处理项目授权并执行推理流程，不读取用户模型凭据，不访问外部模型。测试中的 `echo` 仅在临时工作区执行。

## 分发

从发布标签构建，将完整的 `dist/`、项目许可证、第三方声明和对应源码的获取方式随包提供。发布前按[分发包安装步骤](installation.md#使用分发包)在没有项目依赖的目录中验证启动。
