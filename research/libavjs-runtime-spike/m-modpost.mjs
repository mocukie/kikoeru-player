// 拋棄式 spike（#17）：主執行緒 compileStreaming 一次，把 WebAssembly.Module postMessage 給 Worker，Worker 用它建立 libav.js instance。
// 對照：Worker 自己 compileStreaming。量 compile、instantiate（含 libav.js 初始化）與第一次開檔的時間。
import { spawnSvc } from "./svc.mjs";

export async function run({ reps = 5 } = {}) {
  const out = { mainCompileMs: [], viaModule: [], selfCompile: [] };
  let module;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    module = await WebAssembly.compileStreaming(fetch("/dist/libav-6.10.9.0-kikoeru-af.wasm.wasm"));
    out.mainCompileMs.push(+(performance.now() - t0).toFixed(1));
  }
  for (const mode of ["viaModule", "selfCompile"]) {
    for (let i = 0; i < reps; i++) {
      const w = spawnSvc();
      await w.ready;
      const t0 = performance.now();
      try {
        if (mode === "viaModule") await w.call("setModule", { module });
        await w.call("add", { file: "ab.mp3" });  // 第一次 add 會 compile（selfCompile）或直接 instantiate（viaModule）
        out[mode].push(+(performance.now() - t0).toFixed(1));
      } catch (e) { out[mode].push(`error: ${e.message}`); }
      w.terminate();
    }
  }
  // 也直接試 structured clone 的行為（不經 libav.js）
  try {
    const ch = new MessageChannel();
    const got = new Promise((r) => { ch.port2.onmessage = (e) => r(e.data instanceof WebAssembly.Module); });
    ch.port1.postMessage(module);
    out.messageChannelClone = await got;
  } catch (e) { out.messageChannelClone = `threw ${e.name}: ${e.message}`; }
  return out;
}
