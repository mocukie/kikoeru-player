// 拋棄式 spike（#20，沿用 #10）：量 dist 內每個 wasm／glue 的 raw／gzip -9／brotli q11 大小（KiB）。
// 用法：node measure.mjs <dist 目錄>
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const [dist] = process.argv.slice(2);
const kib = (n) => (n / 1024).toFixed(1);
console.log("| 檔案 | raw KiB | gzip -9 KiB | brotli q11 KiB |\n|---|---|---|---|");
for (const f of readdirSync(dist).sort()) {
  if (!/\.(wasm|mjs)$/.test(f)) continue;
  const b = readFileSync(`${dist}/${f}`);
  const gz = gzipSync(b, { level: 9 }).length;
  const br = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
  console.log(`| ${f.replace("libav-6.10.9.0-", "")} | ${kib(b.length)} | ${kib(gz)} | ${kib(br)} |`);
}
