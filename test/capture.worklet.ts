// 錄音 worklet：把輸入原樣送到輸出，並把每個 render quantum 的 stereo 輸入複製後經 `port` 送出
// （每 8 個 quantum 一批，`{ frame: number; left: Float32Array; right: Float32Array }`，`frame` 是這批第一個 sample 的
// context frame）。由 addModule 原樣載入，不 import 任何東西。

const BATCH_QUANTA = 8;

class CaptureProcessor extends AudioWorkletProcessor {
  #frame = 0;
  #left: Float32Array[] = [];
  #right: Float32Array[] = [];

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0] ?? [];
    const frames = output[0]?.length ?? 128;
    const input = inputs[0] ?? [];
    // 上游沒有輸出時 input 沒有聲道，視為靜音。
    const left = input[0] ?? new Float32Array(frames);
    const right = input[1] ?? left;
    output[0]?.set(left);
    output[1]?.set(right);
    if (this.#left.length === 0) this.#frame = currentFrame;
    this.#left.push(left.slice());
    this.#right.push(right.slice());
    if (this.#left.length >= BATCH_QUANTA) {
      this.port.postMessage({
        frame: this.#frame,
        left: concat(this.#left),
        right: concat(this.#right),
      });
      this.#left = [];
      this.#right = [];
    }
    return true;
  }
}

function concat(blocks: Float32Array[]): Float32Array {
  const result = new Float32Array(blocks.reduce((sum, b) => sum + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

registerProcessor('capture', CaptureProcessor);
