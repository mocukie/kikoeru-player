// 拋棄式 spike（#18）：t-support 的結果。用法：node summarize-support.mjs <results.json>...
// 同一個瀏覽器的多個 run（每檔一個 context）會合併。
import { readFileSync } from "node:fs";
const by = {};
for (const file of process.argv.slice(2)) {
  const R = JSON.parse(readFileSync(file, "utf8"));
  for (const [key, byB] of Object.entries(R)) {
    if (!key.startsWith("support")) continue;
    for (const [b, r] of Object.entries(byB)) {
      const o = by[`${b} ${r.version}`] ??= { matrix: null, files: {} };
      if (!r.ok) { const f = JSON.parse(key.slice(8) || "{}").files?.[0] ?? key; o.files[f] = { crash: r.error.slice(0, 60) }; continue; }
      o.matrix ??= r.result.matrix;
      Object.assign(o.files, r.result.files);
    }
  }
}
for (const [b, o] of Object.entries(by)) {
  console.log(`\n#### ${b}\n\n| codec 字串 | isConfigSupported 為 true 的 取樣率k/聲道 |\n| --- | --- |`);
  for (const [c, m] of Object.entries(o.matrix ?? {})) console.log(`| ${c} | ${m.yes === "all" ? "全部" : m.yes.length ? m.yes.join(" ") : "（無）"}${m.thrown.length ? "；" + m.thrown.join(",") : ""} |`);
  console.log(`\n| 檔案 | config | supported | 實際 decode | 判定 |\n| --- | --- | --- | --- | --- |`);
  for (const [f, x] of Object.entries(o.files)) {
    if (x.crash) { console.log(`| ${f} | | | **${x.crash}** | crash |`); continue; }
    if (x.error) { console.log(`| ${f} | | | ${x.error.slice(0, 80)} | |`); continue; }
    const d = x.decode;
    console.log(`| ${f} | ${x.config.codec} ${x.config.sampleRate / 1000}k/${x.config.numberOfChannels}${x.config.description ? ` desc ${x.config.description}B` : ""} | ${x.supported} | ${d.error ?? `${d.samples}/${d.wasmSamples} samples, ${d.outSr / 1000}k/${d.outCh}ch ${d.format}`} | ${x.verdict} |`);
  }
}
