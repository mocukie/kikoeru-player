// 組好 createEngineWith() 的假 deps。

import {
  FakeAudioOutput,
  type FakeAudioOutputConfig,
  type FakeAudioOutputHandlers,
} from './audio-output.js';
import { FakeMediaWorkers } from './media-worker.js';

/** 最小的合法 wasm（只有 magic 與版本），讓 `init` 帶的是真正的 `WebAssembly.Module`。 */
const emptyModule = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

export interface FakeEngineDeps {
  platform: 'desktop';
  loadWasm(): Promise<{ module: WebAssembly.Module; glueUrl: string }>;
  createWorker: FakeMediaWorkers['create'];
  createAudioOutput(
    handlers: FakeAudioOutputHandlers,
    config: FakeAudioOutputConfig,
  ): FakeAudioOutput;
  workers: FakeMediaWorkers;
  /** 最後建立的音訊輸出（watchdog 重建後是新的那個）；還沒建立時讀取會丟錯。 */
  readonly audio: FakeAudioOutput;
  /** 依建立順序的所有音訊輸出。 */
  readonly audioOutputs: FakeAudioOutput[];
  /** `audio` 的建立次數。 */
  readonly audioCreated: number;
  /** `loadWasm()` 的呼叫次數。 */
  wasmLoads: number;
}

/** `onAudio`：音訊輸出建立時呼叫，用來在 Engine 使用它之前設定行為（例如 `connectError`）。 */
export function createFakeDeps(
  options: { onAudio?: (audio: FakeAudioOutput) => void } = {},
): FakeEngineDeps {
  const workers = new FakeMediaWorkers();
  const outputs: FakeAudioOutput[] = [];
  return {
    platform: 'desktop',
    loadWasm() {
      this.wasmLoads++;
      return Promise.resolve({ module: emptyModule, glueUrl: '/libav.wasm.mjs' });
    },
    createWorker: workers.create,
    createAudioOutput(handlers, config) {
      const audio = new FakeAudioOutput(handlers, config);
      outputs.push(audio);
      options.onAudio?.(audio);
      return audio;
    },
    workers,
    get audio() {
      const audio = outputs.at(-1);
      if (!audio) throw new Error('還沒有建立音訊輸出');
      return audio;
    },
    audioOutputs: outputs,
    get audioCreated() {
      return outputs.length;
    },
    wasmLoads: 0,
  };
}
