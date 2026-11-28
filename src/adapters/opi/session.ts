import type { Interaction, InteractionAnswer } from "../../shared/management.ts";
import { isAbsoluteDirectory } from "../../shared/session-creation.ts";
import { OpiClient } from "./client.ts";
import { queryDirectories } from "./directories.ts";
import { ExecutionState } from "./execution.ts";
import { decodeDialog, dialogAction, type Selected } from "./wire.ts";

export class SessionPort {
  readonly client: OpiClient; readonly execution = new ExecutionState();
  selected: Selected | null = null; owned: Selected | null = null; dialogs: Interaction[] = []; file: string | null = null;
  private previousId: string | null = null; private responses = new Set<Promise<void>>(); private pulses = new Set<() => void>();
  constructor(target: URL, changed: () => void, monitor = false, attachId?: string) {
    this.client = new OpiClient(target, (event) => {
      if (event.type === "selected") {
        if (attachId && event.session?.id !== attachId) throw new Error("原计划会话已不存在，无法确认取消");
        this.selected = event.session; this.dialogs = [];
        if (event.session && (attachId || this.previousId && event.session.id !== this.previousId)) this.owned = event.session;
      }
      if (event.type === "dialogs") {
        const selected = this.selected;
        if (!selected && event.value.length) throw new Error("会话交互缺少会话身份");
        this.dialogs = selected ? event.value.map((raw) => decodeDialog(raw, selected.id)) : [];
      }
      if (event.type === "activity" && (this.owned || attachId)) {
        const id = this.owned?.id ?? attachId;
        const active = event.value.find((item) => item.sessionId === id); if (active?.path) this.file = active.path;
      }
      if (["selected", "dialogs", "activity"].includes(event.type)) { changed(); this.pulse(); }
    }, attachId ?? "hub-session-operation", monitor ? (raw) => { if (this.execution.consume(raw)) { changed(); this.pulse(); } } : undefined);
  }
  private pulse(): void { for (const resolve of this.pulses) resolve(); }
  async create(path: string, signal: AbortSignal, phase: (value: "workspace" | "new", path: string) => void): Promise<Selected> {
    if (!isAbsoluteDirectory(path)) throw new Error("需要目标设备上的绝对目录路径");
    const listing = await queryDirectories(this.client, path, AbortSignal.any([signal, AbortSignal.timeout(15_000)])); phase("workspace", listing.path);
    await this.client.action({ action: "workspace", path: listing.path }, null, signal); await this.client.synchronize(signal);
    const previous = this.selected; if (!previous) throw new Error("o-pi 未选择目标工作区");
    this.previousId = previous.id; phase("new", listing.path);
    await this.client.action({ action: "new" }, previous.id, signal); await this.client.synchronize(signal);
    const session = this.selected;
    if (!session || session.id === previous.id || session.cwd !== listing.path) throw new Error("o-pi 未返回目标目录中的全新会话");
    return session;
  }
  async respond(answer: InteractionAnswer): Promise<void> {
    const response = this.client.action(dialogAction(this.dialogs, answer), answer.sessionId, AbortSignal.timeout(25_000)); this.responses.add(response);
    try { await response; } finally { this.responses.delete(response); }
  }
  async waitIdle(input: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([input, this.client.signal]);
    while (true) {
      signal.throwIfAborted();
      if (this.owned && this.execution.sessionId === this.owned.id && !this.execution.busy) return;
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); }; const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { this.pulses.delete(done); signal.removeEventListener("abort", abort); };
        this.pulses.add(done); signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  async abort(): Promise<void> {
    const session = this.owned; if (!session) return;
    const signal = AbortSignal.timeout(5000);
    await this.client.action({ action: "abort" }, session.id, signal); await this.client.synchronize(signal); await this.waitIdle(signal);
  }
  async finish(): Promise<void> { this.dialogs = []; await Promise.allSettled([...this.responses]); this.client.close(); }
  close(): void { this.client.close(); }
}
