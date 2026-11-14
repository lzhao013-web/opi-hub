import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual, scrypt } from "node:crypto";
import { object } from "../shared/protocol.ts";
import { isNotificationDestination } from "../shared/notifications.ts";

export interface Device { id: string; name: string; tokenHash: string; createdAt: string; notificationDestination?: string }
interface Data { version: 1; passwordHash: string; devices: Device[] }
export const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, (error, key) => error ? reject(error) : resolve(key)));
}
async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
function isDevice(value: unknown): value is Device {
  return object(value) && typeof value.id === "string" && /^[a-f0-9-]{36}$/.test(value.id) &&
    typeof value.name === "string" && typeof value.tokenHash === "string" && /^[a-f0-9]{64}$/.test(value.tokenHash) && typeof value.createdAt === "string" && (value.notificationDestination === undefined || isNotificationDestination(value.notificationDestination));
}
export class Store {
  private writing: Promise<void> = Promise.resolve();
  readonly file: string;
  private data: Data;
  private constructor(file: string, data: Data) { this.file = file; this.data = data; }
  static async init(directory: string, password: string): Promise<void> {
    if (password.length < 12) throw new Error("密码至少需要 12 个字符");
    await mkdir(directory, { recursive: true });
    const data: Data = { version: 1, passwordHash: await passwordHash(password), devices: [] };
    await writeFile(path.join(directory, "hub.json"), JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  static async open(directory: string): Promise<Store> {
    const file = path.join(directory, "hub.json");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!object(value) || value.version !== 1 || typeof value.passwordHash !== "string" || !Array.isArray(value.devices) || !value.devices.every(isDevice)) throw new Error("无效的中心数据文件");
    if (new Set(value.devices.map((device) => device.id)).size !== value.devices.length) throw new Error("设备标识重复");
    return new Store(file, { version: 1, passwordHash: value.passwordHash, devices: value.devices });
  }
  async verifyPassword(password: string): Promise<boolean> {
    const [salt, expected] = this.data.passwordHash.split(":");
    if (!salt || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("无效的密码记录");
    return timingSafeEqual(await derive(password, salt), Buffer.from(expected, "hex"));
  }
  list(): Device[] { return this.data.devices.map((device) => ({ ...device })); }
  get(id: string): Device | undefined { return this.list().find((device) => device.id === id); }
  authenticate(token: string): Device | undefined {
    const [id, key, extra] = token.split(".");
    if (!id || !key || extra !== undefined) return undefined;
    const device = this.data.devices.find((item) => item.id === id);
    if (!device) return undefined;
    return timingSafeEqual(Buffer.from(hash(key), "hex"), Buffer.from(device.tokenHash, "hex")) ? { ...device } : undefined;
  }
  add(name: string): Promise<{ device: Device; token: string }> {
    return this.mutate((data) => {
      const key = secret();
      const device: Device = { id: randomUUID(), name, tokenHash: hash(key), createdAt: new Date().toISOString() };
      data.devices.push(device);
      return { device: { ...device }, token: `${device.id}.${key}` };
    });
  }
  bindNotifications(deviceId: string | null, destination: string): Promise<boolean> {
    if (!isNotificationDestination(destination)) return Promise.reject(new Error("无效的通知接收端标识"));
    return this.mutate((data) => {
      const target = data.devices.find((device) => device.id === deviceId);
      if (deviceId !== null && !target) return false;
      // 每个浏览器配置只绑定一个节点，每个节点同时服务一个浏览器配置。
      for (const device of data.devices) if (device.notificationDestination === destination) delete device.notificationDestination;
      if (target) target.notificationDestination = destination;
      return true;
    });
  }
  remove(id: string): Promise<void> {
    return this.mutate((data) => { data.devices = data.devices.filter((device) => device.id !== id); });
  }
  private mutate<T>(operation: (data: Data) => T): Promise<T> {
    const task = this.writing.then(async () => {
      const next: Data = { ...this.data, devices: this.list() };
      const result = operation(next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, this.file);
      this.data = next;
      return result;
    });
    this.writing = task.then(() => {}, () => {});
    return task;
  }
}
