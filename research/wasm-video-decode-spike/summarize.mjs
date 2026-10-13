// 拋棄式 spike（#20）：把 bench.sh 的結果 JSON 整理成報告用的 Markdown 表格。
// 用法：node summarize.mjs <res 目錄>
import { readFileSync, existsSync } from "node:fs";

const res = process.argv[2];
const B = ["chromium", "webkit", "firefox"];
const load = (n) => existsSync(`${res}/${n}.json`) ? Object.entries(JSON.parse(readFileSync(`${res}/${n}.json`, "utf8"))).map(([k, v]) => {
  const i = k.indexOf(" "); return { test: i < 0 ? k : k.slice(0, i), p: i < 0 ? {} : JSON.parse(k.slice(i + 1)), r: v };
}) : [];
const get = (rows, pred) => rows.find((x) => pred(x.p));
const cell = (row, b, f) => { const r = row?.r?.[b]; if (!r) return "—"; if (!r.ok) return "失敗"; return f(r.result); };
const nm = (f) => f.replace(".mp4", "");
const flv = (p) => `${p.flavor ?? "oz"}${p.noasy ? "-noasy" : ""}`;

// 1. 單執行緒
const single = load("single");
if (single.length) {
  console.log("\n### 單執行緒（decode-only fps ／ 即時倍數 ／ 預先解碼 ms）\n");
  console.log(`| 檔案 | 內容 fps | ${B.map((b) => `${b} oz（Engine 條件）| ${b} o3s-noasy`).join(" | ")} |`);
  console.log(`|---|---|${B.map(() => "---|---").join("|")}|`);
  const files = [...new Set(single.map((x) => x.p.file))];
  for (const f of files) {
    const a = get(single, (p) => p.file === f && !p.flavor), o = get(single, (p) => p.file === f && p.flavor === "o3s" && p.noasy);
    const c = (r) => `${r.decodeOnlyFps} ／ ${r.realtimeFactor}× ／ ${r.prerollMsDecodeOnly}`;
    const fps = a?.r?.chromium?.result?.contentFps ?? "";
    console.log(`| ${nm(f)} | ${fps} | ${B.map((b) => `${cell(a, b, c)} | ${cell(o, b, c)}`).join(" | ")} |`);
  }
  console.log("\nper-packet decode ms（oz，p50／p95／p99／max）：\n");
  console.log(`| 檔案 | ${B.join(" | ")} |\n|---|${B.map(() => "---").join("|")}|`);
  for (const f of files) {
    const a = get(single, (p) => p.file === f && !p.flavor);
    console.log(`| ${nm(f)} | ${B.map((b) => cell(a, b, (r) => { const s = r.perPacketDecodeMs; return `${s.p50}／${s.p95}／${s.p99}／${s.max}`; })).join(" | ")} |`);
  }
}

// 2. flavors
const fl = load("flavors");
if (fl.length) {
  console.log("\n### 編譯選項 × Asyncify（decode-only fps）\n");
  const combos = ["oz", "oz-noasy", "o3", "o3-noasy", "o3s", "o3s-noasy"];
  for (const b of B) {
    console.log(`\n${b}：\n\n| 檔案 | ${combos.join(" | ")} |\n|---|${combos.map(() => "---").join("|")}|`);
    for (const f of [...new Set(fl.map((x) => x.p.file))]) {
      console.log(`| ${nm(f)} | ${combos.map((c) => cell(get(fl, (p) => p.file === f && flv(p) === c), b, (r) => r.decodeOnlyFps)).join(" | ")} |`);
    }
  }
}

// 3. threads
const th = load("threads");
if (th.length) {
  console.log("\n### wasm threads（o3s-noasy，crossOriginIsolated；wall-clock fps）\n");
  const ns = [...new Set(th.map((x) => x.p.threads))];
  for (const b of B) {
    console.log(`\n${b}：\n\n| 檔案 | ${ns.map((n) => `${n} thread`).join(" | ")} |\n|---|${ns.map(() => "---").join("|")}|`);
    for (const f of [...new Set(th.map((x) => x.p.file))]) {
      console.log(`| ${nm(f)} | ${ns.map((n) => cell(get(th, (p) => p.file === f && p.threads === n), b, (r) => r.decodeFps)).join(" | ")} |`);
    }
  }
}

// 4. pipeline
const pl = load("pipeline");
if (pl.length) {
  console.log("\n### 完整路徑（pipeline fps ／ 取出 I420 ms p50 ／ new VideoFrame ms p50 ／ drawImage ms p50）\n");
  console.log(`| 檔案 | flavor | ${B.join(" | ")} |\n|---|---|${B.map(() => "---").join("|")}|`);
  for (const x of pl) {
    console.log(`| ${nm(x.p.file)} | ${flv(x.p)} | ${B.map((b) => cell(x, b, (r) => `${r.pipelineFps} ／ ${r.copyMs?.p50} ／ ${r.videoFrameMs?.p50} ／ ${r.drawImageMs?.p50}`)).join(" | ")} |`);
  }
}

// 5. vfcost
const vc = load("vfcost");
if (vc.length) {
  console.log("\n### new VideoFrame（CPU buffer，ms p50／p95）與 JS 取出成本\n");
  const rows = vc[0].r;
  const list = rows.chromium?.result ?? [];
  console.log(`| 尺寸 | 項目 | ${B.join(" | ")} |\n|---|---|${B.map(() => "---").join("|")}|`);
  list.forEach((it, i) => {
    const label = it.format ? `${it.format}${it.transfer ? "＋transfer" : ""}` : "取出 8-bit ／ 10→8-bit 轉換";
    const f = (r) => { const o = r[i]; if (o.format) return o.ok ? `${o.newVideoFrameMs.p50}／${o.newVideoFrameMs.p95}` : o.err.split(":")[0]; return `${o.copyStrided8To_I420Ms.p50} ／ ${o.convert10to8Ms.p50}`; };
    console.log(`| ${it.w}×${it.h} | ${label} | ${B.map((b) => rows[b]?.ok ? f(rows[b].result) : "—").join(" | ")} |`);
  });
}

// 6. skip
const sk = load("skip");
if (sk.length) {
  console.log("\n### 只解 reference frame／不套 grain（輸出 frame 數 ／ decode-only fps）\n");
  console.log(`| 檔案 | 設定 | ${B.join(" | ")} |\n|---|---|${B.map(() => "---").join("|")}|`);
  for (const x of sk) console.log(`| ${nm(x.p.file)} | ${x.p.skip ? "skip_frame=noref" : "grain=false"} | ${B.map((b) => cell(x, b, (r) => `${r.frames} ／ ${r.decodeOnlyFps}`)).join(" | ")} |`);
}
