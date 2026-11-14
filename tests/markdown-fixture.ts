export const MARKDOWN_REPLY = `# 巡检报告

已检查 **12 个模块**，本轮移除 ~~旧问题~~，保留 \`warning\` 供复核。

## 检查结果

- **通过**：类型检查
- **待复核**：边界条件
  - 不改变原审批规则

> 已结束只表示执行结束，不代表内容已经验证成功。

| 检查项 | 结果 |
| :--- | ---: |
| 类型检查 | 通过 |
| 定向测试 | 通过 |

\`\`\`ts
const result = "<img src=x onerror=alert(1)>";
const longLine = "这是一段用于检查代码块横向滚动而不撑破手机布局的长内容，这是一段用于检查代码块横向滚动而不撑破手机布局的长内容。";
\`\`\`

[外部文档](https://example.com/report) · [发送邮件](mailto:review@example.com)

![跟踪图片](https://tracking.example/pixel.png)

<script>alert("不应执行")</script>
<img src="https://tracking.example/html.png" onerror="alert(1)">
<iframe src="https://tracking.example/frame"></iframe>

[脚本链接](javascript:alert(1))
[实体脚本](jav&#x61;script:alert(1))
[数据链接](data:text/html;base64,PHNjcmlwdD4=)
[本机文件](file:///C:/private.txt)
[相对操作](/_hub/logout)

最后一段：中文、换行与 emoji 😀 都应正常显示。
`;
