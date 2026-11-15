import { WebSocket, type PerMessageDeflateOptions, type RawData } from "ws";
import { MAX_DATA_FRAME, send } from "./protocol.ts";

/** 跨设备数据逐帧压缩，不跨消息复用字典，限制压缩并发与小帧开销。 */
export const DATA_COMPRESSION = {
  serverNoContextTakeover: true, clientNoContextTakeover: true,
  threshold: 1024, concurrencyLimit: 4, zlibDeflateOptions: { level: 3 },
} satisfies PerMessageDeflateOptions;

export function buffer(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
/** 独立的数据连接使用暂停读取和发送回调传播背压，避免慢文件阻塞设备控制通道。 */
export function forward(source: WebSocket, target: WebSocket): void {
  let queued = 0;
  let writing = Promise.resolve();
  source.on("message", (raw, binary) => {
    const data = buffer(raw);
    queued += data.length;
    if (queued > MAX_DATA_FRAME * 2) { source.terminate(); target.terminate(); return; }
    source.pause();
    writing = writing.then(() => send(target, data, binary)).then(() => {
      queued -= data.length;
      if (!queued && source.readyState === WebSocket.OPEN) source.resume();
    }).catch(() => { source.terminate(); target.terminate(); });
  });
}
export function couple(a: WebSocket, b: WebSocket): void {
  a.on("error", () => { a.terminate(); b.terminate(); });
  b.on("error", () => { a.terminate(); b.terminate(); });
  a.once("close", () => b.readyState === WebSocket.OPEN ? b.close(1000) : b.terminate());
  b.once("close", () => a.readyState === WebSocket.OPEN ? a.close(1000) : a.terminate());
}
export function connected(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = (reason: Error) => { cleanup(); reject(reason); };
    const close = () => error(new Error("连接在握手完成前关闭"));
    const open = () => { cleanup(); resolve(); };
    const cleanup = () => { ws.off("error", error); ws.off("close", close); ws.off("open", open); };
    ws.once("open", open); ws.once("error", error); ws.once("close", close);
  });
}
