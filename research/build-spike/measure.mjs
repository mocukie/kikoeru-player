// 拋棄式 spike（#10）：量 raw／gzip -9／brotli q11 大小（KiB）。
// 用法：node measure.mjs <dist 目錄> <libav.js 版本> <variant...>
import { readFileSync, existsSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const [dist, ver, ...variants] = process.argv.slice(2);
const kib = (n) => (n / 1024).toFixed(1);
const row = (label, file) => {
  if (!existsSync(file)) return;
  const b = readFileSync(file);
  const gz = gzipSync(b, { level: 9 }).length;
  const br = brotliCompressSync(b, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length },
  }).length;
  console.log(`| ${label} | ${kib(b.length)} | ${kib(gz)} | ${kib(br)} |`);
};

console.log("| 檔案 | raw KiB | gzip -9 KiB | brotli q11 KiB |\n|---|---|---|---|");
for (const v of variants) {
  row(`${v}.wasm.wasm`, `${dist}/libav-${ver}-${v}.wasm.wasm`);
  row(`${v}.wasm.mjs（factory／glue）`, `${dist}/libav-${ver}-${v}.wasm.mjs`);
  row(`${v}.mjs（frontend）`, `${dist}/libav-${ver}-${v}.mjs`);
}
