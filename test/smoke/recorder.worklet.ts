// 錄音 worklet：把輸入原樣送到輸出，並經 `port` 回報累計的 frame 數與峰值（{ frames, peak }）。
// 由 addModule 原樣載入，不 import 任何東西。

/** 每幾個 render quantum 回報一次。 */
const REPORT_INTERVAL = 16;

class RecorderProcessor extends AudioWorkletProcessor {
  #frames = 0;
  #peak = 0;
  #quanta = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    input.forEach((channel, index) => {
      output[index]?.set(channel);
      for (const sample of channel) this.#peak = Math.max(this.#peak, Math.abs(sample));
    });
    this.#frames += output[0]?.length ?? 0;
    if (++this.#quanta % REPORT_INTERVAL === 0) {
      this.port.postMessage({ frames: this.#frames, peak: this.#peak });
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
