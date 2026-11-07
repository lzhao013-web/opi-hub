export class HistoryStore {
  constructor(request, changed) {
    this.request = request; this.changed = changed;
    this.devices = new Map(); this.entries = new Map(); this.pending = new Map(); this.errors = new Map();
  }
  reconcile(devices) {
    const next = new Map(devices.map((device) => [device.id, device]));
    for (const id of new Set([...this.entries.keys(), ...this.pending.keys(), ...this.errors.keys()])) {
      const device = next.get(id);
      if (!device?.connected || device.management.state !== "ready" || device.connectionId !== this.devices.get(id)?.connectionId) {
        this.pending.get(id)?.controller.abort(); this.pending.delete(id); this.entries.delete(id); this.errors.delete(id);
      }
    }
    this.devices = next;
  }
  async load(id) {
    const device = this.devices.get(id);
    if (!device?.connected || device.management.state !== "ready" || this.pending.has(id)) return;
    const job = { controller: new AbortController(), connectionId: device.connectionId };
    this.pending.set(id, job); this.entries.delete(id); this.errors.delete(id); this.changed();
    try {
      const result = await this.request("/_hub/history", { method: "POST", signal: job.controller.signal, body: JSON.stringify({ deviceId: id }) });
      const current = this.devices.get(id);
      if (this.pending.get(id) !== job) return;
      if (result.connectionId !== current?.connectionId || result.connectionId !== job.connectionId || current.management.state !== "ready") { this.errors.set(id, "设备连接已变化，请刷新后重新加载历史。"); return; }
      this.entries.set(id, result.entries);
    } catch (error) { if (!job.controller.signal.aborted && this.pending.get(id) === job) this.errors.set(id, error.message); }
    finally { if (this.pending.get(id) === job) { this.pending.delete(id); this.changed(); } }
  }
  cancel(id) { this.pending.get(id)?.controller.abort(); this.pending.delete(id); this.changed(); }
  clear() {
    for (const job of this.pending.values()) job.controller.abort();
    this.pending.clear(); this.entries.clear(); this.errors.clear(); this.devices.clear();
  }
  sessions(data, deviceId, cwd) {
    const active = data.sessions.filter((item) => (!deviceId || item.deviceId === deviceId) && (!cwd || item.cwd === cwd));
    const byFile = new Map(data.sessions.filter((item) => item.file).map((item) => [JSON.stringify([item.deviceId, item.file]), item]));
    const result = new Map(active.map((item) => [JSON.stringify([item.deviceId, item.target]), item]));
    for (const [id, entries] of this.entries) {
      if (deviceId && id !== deviceId) continue;
      for (const entry of entries) {
        if (cwd && entry.cwd !== cwd) continue;
        const live = byFile.get(JSON.stringify([id, entry.path]));
        const value = live ? { ...live, title: entry.title || live.title } : { deviceId: id, target: { path: entry.path }, file: entry.path, title: entry.title, cwd: entry.cwd, modified: entry.modified, state: "history" };
        result.set(JSON.stringify([id, value.target]), value);
      }
    }
    return [...result.values()];
  }
}
