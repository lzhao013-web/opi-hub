import { fixture } from "./helpers.ts";
const env = await fixture(19291);
console.log(`Browser fixture: ${env.hub.url}`);
process.send?.("ready");
let closing = false;
const close = async () => { if (closing) return; closing = true; await env.close(); process.exit(0); };
process.on("message", (message) => { if (message === "stop") void close(); });
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
