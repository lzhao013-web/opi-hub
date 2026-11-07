import type { Interaction, ManagedSession } from "../shared/management.ts";
import type { Store } from "./store.ts";
import type { Nodes } from "./nodes.ts";

export function overview(store: Store, nodes: Nodes) {
  const sessions: (ManagedSession & { deviceId: string })[] = [];
  const interactions: (Interaction & { deviceId: string })[] = [];
  const workspaces: { deviceId: string; path: string }[] = [];
  const devices = store.list().map(({ tokenHash: _hash, ...device }) => {
    const management = nodes.management(device.id);
    if (management?.state === "ready") {
      workspaces.push(...management.workspaces.map((path) => ({ deviceId: device.id, path })));
      sessions.push(...management.sessions.map((session) => ({ ...session, deviceId: device.id })));
      interactions.push(...management.interactions.map((dialog) => ({ ...dialog, deviceId: device.id })));
    }
    return { ...device, ...nodes.status(device.id), management: management?.state === "ready"
      ? { state: "ready" as const, issues: management.issues } : management ?? { state: "connecting" as const } };
  });
  return { devices, workspaces, sessions, interactions };
}
