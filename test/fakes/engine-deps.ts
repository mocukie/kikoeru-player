// 組好 createEngineWith() 的假 deps。

import { FakeAudioOutput, type FakeAudioOutputConfig } from './audio-output.js';
import { FakeMediaWorkers } from './media-worker.js';
import type { WorkletToMainMessage } from '../../src/protocol/index.js';

/** 最小的合法 wasm（只有 magic 與版本），讓 `init` 帶的是真正的 `WebAssembly.Module`。 */
const emptyModule = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

export interface FakeEngineDeps {
  platform: 'desktop';
  loadWasm(): Promise<{ module: WebAssembly.Module; glueUrl: string }>;
  createWorker: FakeMediaWorkers['create'];
  createAudioOutput(
    onMessage: (message: WorkletToMainMessage) => void,
    config: FakeAudioOutputConfig,
  ): FakeAudioOutput;
  workers: FakeMediaWorkers;
  /** 第一次 load 時建立；之前讀取會丟錯。 */
  readonly audio: FakeAudioOutput;
  /** `audio` 的建立次數。 */
  audioCreated: number;
}

/** `onAudio`：音訊輸出建立時呼叫，用來在 Engine 使用它之前設定行為（例如 `connectError`）。 */
export function createFakeDeps(
  options: { onAudio?: (audio: FakeAudioOutput) => void } = {},
): FakeEngineDeps {
  const workers = new FakeMediaWorkers();
  let audio: FakeAudioOutput | undefined;
  return {
    platform: 'desktop',
    loadWasm: () => Promise.resolve({ module: emptyModule, glueUrl: '/libav.wasm.mjs' }),
    createWorker: workers.create,
    createAudioOutput(onMessage, config) {
      this.audioCreated++;
      audio = new FakeAudioOutput(onMessage, config);
      options.onAudio?.(audio);
      return audio;
    },
    workers,
    get audio() {
      if (!audio) throw new Error('還沒有建立音訊輸出');
      return audio;
    },
    audioCreated: 0,
  };
}
