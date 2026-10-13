// 拋棄式 spike（#18，沿用 #17 的 runner）：起 server、開瀏覽器、依序跑測試，結果寫成 JSON。
// 用法：node run.mjs <dist> <media> <out.json> <browser,...> <test[:json params];...>
// window.__cpu(label)：加總本 process 底下所有瀏覽器 process 的 utime+stime（ms），用來量含 decoder 執行緒／其他 process 的總 CPU。
// Chromium 另外用 CDP 的 Media domain 收 WebCodecs 的 media log（decoder 名稱、是否 platform decoder）。
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { chromium, webkit, firefox } from "playwright";
import { startServer } from "./server.mjs";

const [dist, media, outFile, browsersArg, testsArg] = process.argv.slice(2);
const BROWSERS = { chromium, webkit, firefox };
const tests = testsArg.split(";").map((t) => { const i = t.indexOf(":"); return i < 0 ? [t, {}] : [t.slice(0, i), JSON.parse(t.slice(i + 1))]; });
const TICK_MS = 10; // CLK_TCK = 100

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
function cpuMs() {
  let total = 0; const by = {};
  for (const p of procs()) {
    try {
      const s = readFileSync(`/proc/${p}/stat`, "utf8");
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
      const ms = (+f[11] + +f[12]) * TICK_MS; // utime, stime
      total += ms;
      const name = readFileSync(`/proc/${p}/comm`, "utf8").trim();
      by[name] = (by[name] ?? 0) + ms;
    } catch {}
  }
  return { total, by };
}

const { server, port } = await startServer({ dist, media });
const results = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
for (const bname of browsersArg.split(",")) {
  const browser = await BROWSERS[bname].launch(bname === "chromium" ? { args: ["--js-flags=--expose-gc"] } : {});
  const version = browser.version();
  for (const [test, params] of tests) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const marks = [];
    await page.exposeFunction("__cpu", (label) => { const c = cpuMs(); const m = { label, t: Date.now(), cpuMs: c.total, by: c.by }; marks.push(m); return { label, cpuMs: c.total }; });
    const mediaLog = [];
    if (bname === "chromium" && params.cdpMedia) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Media.enable");
      cdp.on("Media.playerPropertiesChanged", (e) => mediaLog.push({ player: e.playerId, props: e.properties }));
      cdp.on("Media.playerMessagesLogged", (e) => mediaLog.push({ player: e.playerId, msgs: e.messages.map((m) => m.message) }));
      cdp.on("Media.playerErrorsRaised", (e) => mediaLog.push({ player: e.playerId, errors: e.errors }));
    }
    page.on("console", (m) => console.log(`  [${bname}] ${m.text()}`));
    page.on("pageerror", (e) => console.log(`  [${bname}] pageerror ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForFunction(() => window.__ready);
    const t0 = Date.now();
    let r;
    try { r = { ok: true, result: await page.evaluate(([t, p]) => window.__run(t, p), [test, params]) }; }
    catch (e) { r = { ok: false, error: String(e.message).slice(0, 2000) }; }
    r.ms = Date.now() - t0; r.version = version;
    if (marks.length) r.marks = marks;
    if (mediaLog.length) r.mediaLog = mediaLog;
    const key = test + (Object.keys(params).length ? " " + JSON.stringify(params) : "");
    (results[key] ??= {})[bname] = r;
    console.log(`${bname} ${version} ${key}: ${r.ok ? "ok" : "FAIL " + r.error} (${r.ms} ms)`);
    writeFileSync(outFile, JSON.stringify(results, null, 1));
    await ctx.close();
  }
  await browser.close();
}
server.close();
