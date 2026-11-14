import { copyFile, mkdir } from "node:fs/promises";

const directory = new URL("../src/web/vendor/", import.meta.url);
await mkdir(directory, { recursive: true });
await copyFile(new URL(import.meta.resolve("markdown-it/browser")), new URL("markdown-it.js", directory));
await copyFile(new URL("./LICENSE", import.meta.resolve("markdown-it/package.json")), new URL("markdown-it.LICENSE.txt", directory));
