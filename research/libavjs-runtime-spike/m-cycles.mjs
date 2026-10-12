// 拋棄式 spike（#17）：上百次「開檔→解碼→destroy」後的記憶體，重用 Worker 與每次重建 Worker 比較。
// recreate 模式的 Worker 拿主執行緒預先編譯好的 WebAssembly.Module（postMessage），順便驗證各瀏覽器能否這樣傳。
import { spawnSvc, rss, sleep } from "./svc.mjs";

export async function run({ n = 200, batch = 25, mode = "reuse", file = "ab.mp3", what = "full" } = {}, log) {
  const out = { mode, what, n, steps: [] };
  const step = async (label, extra) => { const r = await rss(label); out.steps.push({ ...r, ...extra }); log(`${label} ${JSON.stringify(r)} ${extra ? JSON.stringify(extra) : ""}`); };
  await step("baseline");
  const module = mode === "recreate-module" ? await WebAssembly.compileStreaming(fetch("/dist/libav-6.10.9.0-kikoeru-af.wasm.wasm")) : null;
  if (mode === "reuse") {
    const w = spawnSvc();
    await w.ready;
    for (let i = batch; i <= n; i += batch) {
      const r = await w.call("cycles", { n: batch, file, what });
      await step(`${i} cycles`, r);
    }
    w.terminate();
    await step("terminate Worker");
  } else {
    for (let i = batch; i <= n; i += batch) {
      const times = [];
      for (let j = 0; j < batch; j++) {
        const t0 = performance.now();
        const w = spawnSvc();
        await w.ready;
        if (module) await w.call("setModule", { module });
        await w.call("cycles", { n: 1, file });
        w.terminate();
        times.push(performance.now() - t0);
      }
      await step(`${i} cycles`, { avgMs: +(times.reduce((a, b) => a + b, 0) / batch).toFixed(1) });
    }
  }
  await sleep(3000);
  await step("結束後 3 秒");
  return out;
}
