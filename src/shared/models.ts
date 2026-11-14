import { object } from "./protocol.ts";

export interface ModelRef { provider: string; id: string }
export interface ModelOption extends ModelRef { name: string }
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.includes("\0");
export function isModelRef(value: unknown): value is ModelRef {
  return object(value) && identifier(value.provider) && identifier(value.id);
}
export function isModelOption(value: unknown): value is ModelOption {
  return isModelRef(value) && "name" in value && identifier(value.name);
}
