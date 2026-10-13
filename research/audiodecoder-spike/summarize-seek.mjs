// 拋棄式 spike（#18）：t-seek 的結果印成表格（每個 preroll k：AD 與 wasm 在目標處的 max abs diff、AD 的 tsErr）。
// 用法：node summarize-seek.mjs <results.json>...
import { readFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  const R = JSON.parse(readFileSync(file, "utf8"));
  for (const [key, byB] of Object.entries(R)) {
    if (!key.startsWith("seek")) continue;
    for (const [b, r] of Object.entries(byB)) {
      if (!r.ok) { console.log(`${b} ${key} FAIL ${r.error.slice(0, 100)}`); continue; }
      for (const [f, x] of Object.entries(r.result)) {
        if (x.error) { console.log(`| ${b} | ${f} | ${x.error.slice(0, 100)} |`); continue; }
        const ks = Object.keys(x.wasm);
        const fmt = (d) => !d ? "-" : d.n <= 0 ? "(n0)" : d.max === "0.00e+0" ? "0" : d.max;
        console.log(`| ${b} ${r.version} | ${f} | ` + ks.map((k) => {
          const a = x.ad[k];
          return `k=${k}: AD ${a?.error ? "ERR " + a.error.slice(0, 30) : fmt(a?.atTarget)}${a?.tsErr ? `(ts${a.tsErr > 0 ? "+" : ""}${a.tsErr})` : ""} / wasm ${fmt(x.wasm[k]?.atTarget)}`;
        }).join("; ") + " |");
      }
    }
  }
}
