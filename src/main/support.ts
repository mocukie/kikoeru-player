/**
 * 檢查目前的瀏覽器能否執行 Engine：WebAssembly、module Worker、AudioWorklet（需要 secure context）。
 * 不檢查 codec，也不要求 WebCodecs：沒有 WebCodecs 時影片軌標為不支援，只播音訊。
 */
export function isEngineSupported(): boolean {
  // 以 globalThis 存取，讓缺少這些全域的環境（例如 Node、非 secure context）回傳 false 而不是丟 ReferenceError。
  const g = globalThis as Partial<
    Pick<typeof globalThis, 'WebAssembly' | 'Worker' | 'AudioContext' | 'AudioWorkletNode'>
  >;
  return (
    typeof g.WebAssembly === 'object' &&
    typeof g.Worker === 'function' &&
    typeof g.AudioWorkletNode === 'function' &&
    typeof g.AudioContext === 'function' &&
    'audioWorklet' in g.AudioContext.prototype
  );
}
