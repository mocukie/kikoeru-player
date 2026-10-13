// 拋棄式 spike（#20）：通用的測試 Worker。收到 {test, params} 就跑 t-<test>.mjs 的 run(params, progress, self)。
self.onmessage = async (e) => {
  if (!e.data?.test) return;
  const { test, params } = e.data;
  try {
    const mod = await import(`./t-${test}.mjs`);
    const result = await mod.run(params ?? {}, (m) => self.postMessage({ progress: m }), self);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err?.stack ?? err) });
  }
};
self.postMessage({ ready: true });
