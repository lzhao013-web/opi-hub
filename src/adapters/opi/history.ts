import type { HistoryEntry } from "../../shared/management.ts";
import { OpiClient } from "./client.ts";
import { applyDirectory, type History } from "./wire.ts";

/** 明确查询时才创建未选择会话的全目录客户端，结束或取消后释放，不切换原页面。 */
export async function readHistory(target: URL, signal: AbortSignal): Promise<HistoryEntry[]> {
  signal.throwIfAborted();
  let entries: History[] | undefined;
  const client = new OpiClient(target, (event) => {
    if (event.type === "sessions") entries = event.value;
    if (event.type === "sessionsPatch") entries = applyDirectory(entries, event.value);
  }, "hub-history-query");
  const close = () => client.close();
  signal.addEventListener("abort", close, { once: true });
  try {
    await client.ready;
    await client.refreshCatalog();
    await client.synchronize(signal);
    signal.throwIfAborted();
    if (!entries) throw new Error("o-pi 未返回历史目录");
    return entries.map(({ path, title, cwd, modified }) => ({ path, title, cwd, modified }));
  } finally { signal.removeEventListener("abort", close); client.close(); }
}
