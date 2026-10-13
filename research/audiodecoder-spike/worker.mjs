// 拋棄式 spike（#18）：通用的測試 Worker。收到 {test, params} 就跑 t-<test>.mjs 的 run()。
// mark(label)：請主執行緒（再轉給 Playwright runner）記一次所有瀏覽器 process 的 CPU 時間，等回覆後才繼續。
let ackResolve = null;
const mark = (label) => new Promise((r) => { ackResolve = r; self.postMessage({ mark: label }); });
self.onmessage = async (e) => {
  if (e.data?.markAck !== undefined) { const r = ackResolve; ackResolve = null; r?.(e.data.markAck); return; }
  if (!e.data?.test) return;
  const { test, params } = e.data;
  try {
    const mod = await import(`./t-${test}.mjs`);
    const result = await mod.run(params ?? {}, (m) => self.postMessage({ progress: m }), mark);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err?.stack ?? err) });
  }
};
self.postMessage({ ready: true });
