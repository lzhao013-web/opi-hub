import http from "node:http";

/** 只替换模型 HTTP 边界，SDK、会话和审批均使用真实实现，不调用外部模型。 */
export async function startModel() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      for await (const _chunk of req) { /* 消费 SDK 请求，不保留模型上下文。 */ }
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl-hub-fixture", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "计划验证完成（本机模拟模型）" }, null)); res.write(chunk({}, "stop")); res.end("data: [DONE]\n\n");
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing mock model address");
  return { url: `http://127.0.0.1:${address.port}/v1`, calls: () => calls, async close() { const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed; } };
}
