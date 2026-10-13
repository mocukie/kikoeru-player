// 拋棄式 spike（#20，沿用 #17／#18 的 runner）：起 server、開瀏覽器、依序跑測試，結果累加寫進 JSON。
// 用法：node run.mjs <dist> <media> <out.json> <browser,...> <test[:json params];...>
// params.coi = true 的測試改用帶 COOP/COEP 的 server（crossOriginIsolated，wasm threads 需要）。
// 每個測試開一個新的 browser context／page；同一組 (test, params, browser) 重跑會覆寫舊結果。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium, webkit, firefox } from "playwright";
import { startServer } from "./server.mjs";

const [dist, media, outFile, browsersArg, testsArg] = process.argv.slice(2);
const BROWSERS = { chromium, webkit, firefox };
const tests = testsArg.split(";").filter(Boolean).map((t) => { const i = t.indexOf(":"); return i < 0 ? [t, {}] : [t.slice(0, i), JSON.parse(t.slice(i + 1))]; });

const plain = await startServer({ dist, media });
const coi = await startServer({ dist, media, coi: true });
const results = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
for (const bname of browsersArg.split(",")) {
  const browser = await BROWSERS[bname].launch();
  const version = browser.version();
  for (const [test, params] of tests) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (m) => { const s = m.text(); if (!/pkts,/.test(s)) console.log(`  [${bname}] ${s.slice(0, 300)}`); });
    page.on("pageerror", (e) => console.log(`  [${bname}] pageerror ${e.message}`));
    const port = params.coi ? coi.port : plain.port;
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => window.__ready);
    const t0 = Date.now();
    let r;
    try { r = { ok: true, result: await page.evaluate(([t, p]) => window.__run(t, p), [test, params]) }; }
    catch (e) { r = { ok: false, error: String(e.message).slice(0, 2000) }; }
    r.ms = Date.now() - t0; r.version = version;
    const key = test + (Object.keys(params).length ? " " + JSON.stringify(params) : "");
    (results[key] ??= {})[bname] = r;
    const brief = r.ok ? (r.result?.decodeFps != null ? `${r.result.decodeFps} fps` + (r.result.pipelineFps ? ` / pipeline ${r.result.pipelineFps} fps` : "") : "ok") : "FAIL " + r.error.slice(0, 300);
    console.log(`${bname} ${version} ${key}: ${brief} (${r.ms} ms)`);
    writeFileSync(outFile, JSON.stringify(results, null, 1));
    await ctx.close();
  }
  await browser.close();
}
plain.server.close(); coi.server.close();
