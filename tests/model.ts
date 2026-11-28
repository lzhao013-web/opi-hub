import http from "node:http";
import { object } from "../src/shared/protocol.ts";

export const fixtureWritePrompt = "验证拟写入内容的审批";
export const fixtureShellPrompt = "验证命令审批";
export const fixtureShell = process.platform === "win32" ? "powershell" : "bash";
export const fixtureShellCommand = process.platform === "win32" ? "Write-Output 'hub-approval' > hub-approval.txt" : "printf hub-approval > hub-approval.txt";
export const fixtureInstruction = "只预览修改，不要写入。";

/** 只替换模型 HTTP 边界，SDK、会话和审批均使用真实实现，不调用外部模型。 */
export async function startModel() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      req.setEncoding("utf8");
      let text = ""; for await (const part of req) text += String(part);
      const body: unknown = JSON.parse(text);
      const last: unknown = object(body) && Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
      const content = object(last) ? JSON.stringify(last.content) : undefined;
      let tool: { name: string; args: Record<string, string> } | undefined;
      if (object(last) && last.role === "user") {
        if (content?.includes(fixtureWritePrompt)) tool = { name: "write", args: { path: "hub-approval.txt", content: "拟写入的隔离测试内容\n" } };
        else if (content?.includes(fixtureShellPrompt)) tool = { name: fixtureShell, args: { command: fixtureShellCommand } };
      }
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-hub-fixture", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (tool) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-hub-${calls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, null));
      } else {
        const reply = object(last) && last.role === "tool" && content?.includes(fixtureInstruction) ? "模型收到拒绝说明" : "计划验证完成（本机模拟模型）";
        res.write(chunk({ role: "assistant", content: reply }, null));
      }
      res.write(chunk({}, tool ? "tool_calls" : "stop")); res.end("data: [DONE]\n\n");
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing mock model address");
  return { url: `http://127.0.0.1:${address.port}/v1`, calls: () => calls, async close() { const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed; } };
}
