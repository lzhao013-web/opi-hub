import type { IncomingMessage, ServerResponse } from "node:http";
import { isPlanDefinition } from "../../shared/schedules.ts";
import { object } from "../../shared/protocol.ts";
import { HttpError, readJson, reply } from "../../shared/http.ts";
import type { Auth } from "../auth.ts";
import type { Scheduler } from "./engine.ts";

export async function scheduleRoute(url: URL, req: IncomingMessage, res: ServerResponse, origin: string, auth: Auth, scheduler: Scheduler): Promise<boolean> {
  if (url.pathname !== "/_hub/schedules" && !url.pathname.startsWith("/_hub/schedules/") && !url.pathname.startsWith("/_hub/runs/")) return false;
  const session = auth.require(req);
  if (url.pathname === "/_hub/schedules" && req.method === "GET") { reply(res, 200, scheduler.snapshot()); return true; }
  auth.checkOrigin(req, origin);
  const controller = new AbortController(); const cancel = () => controller.abort();
  session.close.add(cancel); res.once("close", cancel);
  try {
    if (url.pathname === "/_hub/schedules" && req.method === "POST") {
      const body = await readJson(req);
      if (!isPlanDefinition(body) || Object.keys(body).some((key) => !["name", "deviceId", "path", "prompt", "timeoutSeconds", "rule"].includes(key))) throw new HttpError(400, "计划字段无效。任务需为自然语言，不接受 ! 或 / 命令，超时范围 1–10800 秒。");
      reply(res, 201, scheduler.add(body)); return true;
    }
    const plan = /^\/_hub\/schedules\/([a-f0-9-]{36})(?:\/(enable|run))?$/.exec(url.pathname);
    if (plan?.[1]) {
      if (req.method === "DELETE" && !plan[2]) scheduler.remove(plan[1]);
      else if (req.method === "POST" && plan[2] === "enable") {
        const body = await readJson(req); if (!object(body) || typeof body.enabled !== "boolean") throw new HttpError(400, "需要 enabled"); scheduler.enable(plan[1], body.enabled);
      } else if (req.method === "POST" && plan[2] === "run") { reply(res, 202, scheduler.runNow(plan[1])); return true; }
      else throw new HttpError(405, "不支持此计划操作");
      reply(res, 200, { ok: true }); return true;
    }
    const run = /^\/_hub\/runs\/([a-f0-9-]{36})\/(cancel|acknowledge)$/.exec(url.pathname);
    if (run?.[1] && req.method === "POST") {
      if (run[2] === "cancel") await scheduler.cancel(run[1], controller.signal); else await scheduler.acknowledge(run[1], controller.signal);
      reply(res, 200, { ok: true }); return true;
    }
    throw new HttpError(404, "计划或运行操作不存在");
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(409, error instanceof Error ? error.message : "计划操作失败"); }
  finally { session.close.delete(cancel); res.off("close", cancel); }
}
