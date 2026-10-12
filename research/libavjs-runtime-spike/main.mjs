// 拋棄式 spike（#17）：主執行緒入口。Playwright 呼叫 window.__run(test, params)。
// 名稱以 "m-" 開頭的測試在主執行緒跑（m-<name>.mjs），其餘在一個新的 module Worker 裡跑（t-<name>.mjs）。
const log = (m) => { document.getElementById("log").textContent += m + "\n"; console.log(m); };

export function runInWorker(test, params = {}, transfer = []) {
  const w = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  return new Promise((res, rej) => {
    w.onerror = (e) => { rej(new Error(`worker error: ${e.message}`)); w.terminate(); };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.ready) w.postMessage({ test, params }, transfer);
      else if (d.progress) log(`[${test}] ${d.progress}`);
      else { w.terminate(); d.error ? rej(new Error(d.error)) : res(d.result); }
    };
  });
}

window.__run = async (test, params = {}) => {
  log(`run ${test} ${JSON.stringify(params)}`);
  if (test.startsWith("m-")) {
    const mod = await import(`./${test}.mjs`);
    return mod.run(params, log);
  }
  return runInWorker(test, params);
};
window.__ready = true;
