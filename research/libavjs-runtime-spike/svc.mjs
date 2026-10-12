// 拋棄式 spike（#17）：主執行緒端的 t-svc Worker 包裝。
export function spawnSvc() {
  const w = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  let id = 0;
  const pending = new Map();
  let readyRes, readyRej;
  const ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
  w.onerror = (e) => { readyRej(new Error(e.message)); for (const [, p] of pending) p.rej(new Error(`worker error: ${e.message}`)); };
  w.onmessage = (e) => {
    const d = e.data;
    if (d.ready) w.postMessage({ test: "svc" });
    else if (d.svcReady) readyRes();
    else if (d.error) readyRej(new Error(d.error));
    else if (d.id != null) { const p = pending.get(d.id); pending.delete(d.id); d.ok ? p.res(d.value) : p.rej(new Error(d.value)); }
  };
  const call = async (cmd, args, transfer = []) => {
    await ready;
    return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); w.postMessage({ id: i, cmd, args }, transfer); });
  };
  return { ready, call, terminate: () => w.terminate() };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 讓 GC 有機會跑，再請 runner 量 PSS
export async function rss(label) { await sleep(1500); return window.__rss(label); }
