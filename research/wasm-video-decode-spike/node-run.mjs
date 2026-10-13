// 拋棄式 spike（#20）：在 Node（V8）直接跑 t-decode，開發與快速比較用（沒有 VideoFrame）。
// 用法：node node-run.mjs <dist> <media> '<json params>'
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { env } from "./lib.mjs";
import { run } from "./t-decode.mjs";

const [dist, media, params] = process.argv.slice(2);
env.base = pathToFileURL(resolve(dist)).href;
env.media = resolve(media);
const r = await run(JSON.parse(params), (m) => console.error(m));
console.log(JSON.stringify(r));
process.exit(0);
