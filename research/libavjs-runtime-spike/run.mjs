// 拋棄式 spike（#17）：Playwright runner。起 server、開瀏覽器、依序跑測試，結果寫成 JSON。
// 用法：node run.mjs <dist> <media> <out.json> <browser,...> <test[:json params],...>
// 記憶體：頁面可呼叫 window.__rss(label)，runner 讀 /proc 加總本 process 底下所有瀏覽器 process 的 PSS（MiB）。
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { chromium, webkit, firefox } from "playwright";
import { startServer } from "./server.mjs";

const [dist, media, outFile, browsersArg, testsArg] = process.argv.slice(2);
const BROWSERS = { chromium, webkit, firefox };
const tests = testsArg.split(";").map((t) => { const i = t.indexOf(":"); return i < 0 ? [t, {}] : [t.slice(0, i), JSON.parse(t.slice(i + 1))]; });

function procs() {
  const kids = {};
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = +s.slice(s.lastIndexOf(")") + 2).split(" ")[1];
      (kids[ppid] ??= []).push(+d);
    } catch {}
  }
  const out = [], stack = [process.pid];
  while (stack.length) { const p = stack.pop(); for (const k of kids[p] ?? []) { out.push(k); stack.push(k); } }
  return out;
}
function pssMiB() {
  let total = 0, max = 0, maxName = "";
  for (const p of procs()) {
    try {
      const pss = +/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${p}/smaps_rollup`, "utf8"))[1] / 1024;
      total += pss;
      if (pss > max) { max = pss; maxName = readFileSync(`/proc/${p}/comm`, "utf8").trim(); }
    } catch {}
  }
  return { total: +total.toFixed(1), max: +max.toFixed(1), maxName };
}

const { server, port } = await startServer({ dist, media });
const results = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
for (const bname of browsersArg.split(",")) {
  const browser = await BROWSERS[bname].launch(bname === "chromium" ? { args: ["--js-flags=--expose-gc"] } : {});
  const version = browser.version();
  for (const [test, params] of tests) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rss = [];
    await page.exposeFunction("__rss", (label) => { const s = { label, ...pssMiB() }; rss.push(s); return s; });
    page.on("console", (m) => console.log(`  [${bname}] ${m.text()}`));
    page.on("pageerror", (e) => console.log(`  [${bname}] pageerror ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/index.html${params.coi ? "?coi=1" : ""}`);
    await page.waitForFunction(() => window.__ready);
    const t0 = Date.now();
    let r;
    try { r = { ok: true, result: await page.evaluate(([t, p]) => window.__run(t, p), [test, params]) }; }
    catch (e) { r = { ok: false, error: String(e.message).slice(0, 2000) }; }
    r.ms = Date.now() - t0; r.version = version; if (rss.length) r.rss = rss;
    const key = test + (Object.keys(params).length ? " " + JSON.stringify(params) : "");
    (results[key] ??= {})[bname] = r;
    console.log(`${bname} ${version} ${key}: ${r.ok ? "ok" : "FAIL " + r.error} (${r.ms} ms)`);
    writeFileSync(outFile, JSON.stringify(results, null, 1));
    await ctx.close();
  }
  await browser.close();
}
server.close();
