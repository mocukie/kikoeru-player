// 拋棄式 spike（#18）：t-cpu 的結果印成表格（每媒體秒的 CPU ms，中位數）。用法：node summarize-cpu.mjs <results.json>...
import { readFileSync } from "node:fs";
const P = ["wasm", "wasmNoFilter", "ad", "adNoFilter"];
console.log("| 瀏覽器 | 檔案 | codec／取樣率 | 媒體秒 | " + P.map((p) => `${p} CPU ms/媒體秒（wall）`).join(" | ") + " | AD 輸出格式 |");
console.log("|" + " --- |".repeat(5 + P.length));
for (const file of process.argv.slice(2)) {
  const R = JSON.parse(readFileSync(file, "utf8"));
  for (const [key, byB] of Object.entries(R)) {
    if (!key.startsWith("cpu")) continue;
    for (const [b, r] of Object.entries(byB)) {
      if (!r.ok) { console.log(`| ${b} | ${key} | FAIL ${r.error.slice(0, 60)} |`); continue; }
      for (const [f, x] of Object.entries(r.result)) {
        if (x.error) { console.log(`| ${b} | ${f} | ${x.error.slice(0, 80)} |`); continue; }
        const i = x.info;
        console.log(`| ${b} ${r.version} | ${f} | ${i.codec} ${i.sr / 1000}k${i.bits ? "/" + i.bits : ""} | ${i.mediaSec} | ` +
          P.map((p) => x[p] ? `${x[p].cpuMsPerMediaSec}（${x[p].wallMsPerMediaSec}）` : (p.startsWith("ad") && !x.adSupported ? "不支援" : "-")).join(" | ") +
          ` | ${x.ad?.format ?? x.adNoFilter?.format ?? ""} |`);
      }
    }
  }
}
