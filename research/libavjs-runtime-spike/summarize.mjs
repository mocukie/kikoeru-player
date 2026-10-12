// 拋棄式 spike（#17）：把 run.mjs 的結果 JSON 整理成報告用的 Markdown 表格。
// 用法：node summarize.mjs <results.json>
import { readFileSync } from "node:fs";

const R = JSON.parse(readFileSync(process.argv[2], "utf8"));
const B = ["chromium", "webkit", "firefox"];
const each = (key, fn) => { for (const b of B) { const x = R[key]?.[b]; if (!x) continue; if (!x.ok) { console.log(`- ${b}: FAIL ${x.error}`); continue; } fn(b, x.result, x); } };

console.log("## versions"); for (const b of B) for (const k in R) if (R[k][b]) { console.log(`- ${b} ${R[k][b].version}`); break; }

console.log("\n## abort");
each("abort", (b, r) => {
  console.log(`\n### ${b}\n| file | scenario | strategy | abort call | pb after abort | after recovery (seek+${60} pkts) | tail to EOF |\n|---|---|---|---|---|---|---|`);
  for (const [f, x] of Object.entries(r)) for (const c of x.cases) {
    const res = c.result ? (c.strategy === "devpb-noseek" ? `contig@${c.result.contiguousFromRefIndex} x${c.result.contiguousMatch} res=${c.result.res}` : `${c.result.matchRef}/${c.result.of} res=${c.result.res}`) : c.fatal;
    console.log(`| ${f} | ${c.scenario} | ${c.strategy} | ${c.abortCall}${c.abortedInSeek ? " (aborted inside seek)" : ""} | ${c.pbAfterAbort ? `${c.pbAfterAbort.error}/${c.pbAfterAbort.eof}` : ""} | ${res}${c.reopenMs ? ` reopen ${c.reopenMs}ms` : ""} | ${c.tail ? c.tail.res : ""} |`);
  }
});

for (const key of Object.keys(R).filter((k) => k.startsWith("pending"))) {
  console.log(`\n## ${key}`);
  each(key, (b, r) => console.log(`- ${b}: ${JSON.stringify(r)}`));
}

console.log("\n## speed (ms, median)");
each("speed", (b, r) => {
  const [a, n] = Object.keys(r);
  console.log(`\n### ${b}\n| file | demux A/noA | decode A/noA | decode+filter A/noA |\n|---|---|---|---|`);
  for (const f of Object.keys(r[a])) {
    const x = r[a][f], y = r[n][f];
    if (x.error || y.error) { console.log(`| ${f} | ${x.error ?? ""} ${y.error ?? ""} |`); continue; }
    const p = (u, v) => `${u}/${v} (+${Math.round((u / v - 1) * 100)}%)`;
    console.log(`| ${f} | ${p(x.demuxMs, y.demuxMs)} | ${p(x.decodeMs, y.decodeMs)} | ${p(x.decodeFilterMs, y.decodeFilterMs)} |`);
  }
});

for (const key of Object.keys(R).filter((k) => k.startsWith("m-multi") || k.startsWith("m-cycles"))) {
  console.log(`\n## ${key}`);
  each(key, (b, r) => {
    console.log(`\n### ${b}`);
    for (const s of r.steps) console.log(`- ${s.label}: PSS ${s.total} MiB (max proc ${s.max} ${s.maxName})${s.avgMs ? ` avg ${s.avgMs} ms/cycle` : ""}${s.heapMiB ? ` heap ${s.heapMiB} MiB` : ""}${s.play ? " play " + JSON.stringify(s.play) : ""}`);
  });
}

for (const key of Object.keys(R).filter((k) => k.includes("h264"))) {
  console.log(`\n## ${key}`);
  each(key, (b, r) => {
    for (const [f, x] of Object.entries(r)) if (typeof x === "object")
      for (const [m, y] of Object.entries(x)) if (y?.mode) console.log(`- ${b} ${r.where} ${f} ${m}: supported=${y.isConfigSupported} out=${y.outputs}/${y.inputs} err=${y.error} ${y.ms}ms`);
  });
}

for (const key of Object.keys(R).filter((k) => k.startsWith("m-transfer") || k.startsWith("m-modpost"))) {
  console.log(`\n## ${key}`);
  each(key, (b, r) => console.log(`- ${b}: ${JSON.stringify(r)}`));
}
