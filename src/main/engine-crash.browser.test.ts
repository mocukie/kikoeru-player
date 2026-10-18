// Engine 與真實的 media Worker、wasm（#40）：Worker 丟錯、wasm trap、wasm 記憶體用完都進入 error（INTERNAL），
// reload() 以新的 Worker 恢復；Worker 的 script 載入失敗為 ASSET_LOAD_FAILED。

import { afterEach, expect, test, vi } from 'vitest';
import { mediaUrl } from '../../test/media-worker-harness.js';
import type { WorkerToMainMessage } from '../protocol/index.js';
import { MediaWorker as InPageMediaWorker } from '../worker/media-worker.js';
import { createWebAudioOutput } from './audio-output.js';
import type { EngineDeps, MediaWorker, MediaWorkerHandlers } from './deps.js';
import { createEngine, createEngineWith } from './engine.js';
import { createWebMediaWorker } from './media-worker.js';
import { detectPlatform } from './platform.js';
import type { Engine } from './types.js';
import { loadWasmAssets } from './wasm.js';

const source = { kind: 'http', url: mediaUrl('audio/flac.flac') } as const;

let engine: Engine | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  await engine?.destroy();
  engine = null;
});

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('等待逾時');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function engineWith(createWorker: EngineDeps['createWorker']): Engine {
  return createEngineWith({
    platform: detectPlatform(navigator),
    loadWasm: () => loadWasmAssets(),
    createWorker,
    createAudioOutput: createWebAudioOutput,
  });
}

/** 播放到 1 秒之後，觸發 `fault`，等 Engine 進入 error；再 reload，確認從錯誤的位置繼續播放。 */
async function expectCrashAndRecovery(target: Engine, fault: () => void, message: RegExp) {
  await target.load(source, { paused: false });
  await until(() => target.currentTime > 1);

  fault();
  await until(() => target.state === 'error');
  const error = target.error;
  expect(error).toMatchObject({ name: 'EngineError', code: 'INTERNAL', fatal: true });
  expect(error?.message).toMatch(message);
  expect(error?.position).toBeGreaterThan(1);
  expect((await target.getStats()).resources).toEqual({
    workers: 0,
    libavInstances: 0,
    openVideoFrames: 0,
  });

  await target.reload();
  expect(target.state).toBe('playing');
  expect(target.error).toBeNull();
  expect(target.currentTime).toBeGreaterThanOrEqual(error?.position ?? Infinity);
  const resumed = target.currentTime;
  await until(() => target.currentTime > resumed + 0.3);
  expect((await target.getStats()).resources).toMatchObject({ workers: 1, libavInstances: 1 });
}

test('Worker 丟錯（onerror）：error 為 INTERNAL，reload() 以新的 Worker 恢復', async () => {
  const created: MediaWorker[] = [];
  engine = engineWith((handlers) => {
    const worker = createWebMediaWorker(handlers);
    created.push(worker);
    return worker;
  });
  await expectCrashAndRecovery(
    engine,
    () => {
      // 沒有 port 的 init 讓 Worker 的 onmessage 丟出 TypeError，成為 Worker 的 error 事件。
      const broken = { type: 'init', workletPort: null } as unknown;
      created[0]?.post(broken as Parameters<MediaWorker['post']>[0]);
    },
    /media Worker 崩潰/,
  );
  expect(created).toHaveLength(2);
});

// ─────────────── wasm trap 與記憶體用完：在頁面內執行 MediaWorker，替換 wasm 的一個 export ───────────────

/** 只有一個 export `trap`、內容是 `unreachable` 的 wasm：呼叫它就是真正的 wasm trap。 */
const trapModule = new WebAssembly.Module(
  Uint8Array.from([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    // type section：() => void。
    ...[1, 4, 1, 0x60, 0, 0],
    // function section：一個型別 0 的函式。
    ...[3, 2, 1, 0],
    // export section："trap"。
    ...[7, 8, 1, 4, ...new TextEncoder().encode('trap'), 0x00, 0],
    // code section：沒有 local，unreachable，end。
    ...[10, 5, 1, 3, 0, 0x00, 0x0b],
  ]),
);
const trap = (new WebAssembly.Instance(trapModule).exports as { trap: () => void }).trap;

/** glue 內 `Module._<name>` 對應的 wasm export 名稱（emscripten 會縮短 export 名稱）。 */
async function exportName(name: string): Promise<string> {
  const { glueUrl } = await loadWasmAssets();
  const glue = await (await fetch(glueUrl)).text();
  const found = new RegExp(`_${name}=Module\\["_${name}"\\]=wasmExports\\["([^"]+)"\\]`).exec(glue);
  if (!found?.[1]) throw new Error(`glue 裡找不到 _${name} 的 export`);
  return found[1];
}

/**
 * 在頁面內執行的 media Worker；`fault` 為 true 時，下一次呼叫 wasm 的 `avcodec_send_packet` 改成執行 `fault()`。
 * 被 terminate 之後不再轉送訊息（頁面內無法真的終止它）。
 */
function inPageWorkers(key: string, fault: () => unknown) {
  const state = { armed: false, created: 0 };
  const create = (handlers: MediaWorkerHandlers): MediaWorker => {
    let terminated = false;
    const index = ++state.created;
    const worker = new InPageMediaWorker({
      postMessage: (message: WorkerToMainMessage) => {
        // 與真實的 Worker 一樣非同步送達。
        setTimeout(() => {
          if (!terminated) handlers.message(message);
        }, 0);
      },
      instantiate: async (module, imports) => {
        const instance = await WebAssembly.instantiate(module, imports);
        if (index !== 1) return instance;
        const exports: Record<string, unknown> = { ...instance.exports };
        const original = exports[key] as (...args: unknown[]) => unknown;
        exports[key] = (...args: unknown[]) => {
          if (!state.armed) return original(...args);
          state.armed = false;
          return fault();
        };
        return { exports } as unknown as WebAssembly.Instance;
      },
    });
    return {
      post: (message) => {
        setTimeout(() => {
          if (!terminated) worker.handle(message);
        }, 0);
      },
      terminate: () => {
        terminated = true;
      },
    };
  };
  return { state, create };
}

test('wasm trap：error 為 INTERNAL（wasm-trap），reload() 以新的 Worker 恢復', async () => {
  const workers = inPageWorkers(await exportName('avcodec_send_packet'), trap);
  engine = engineWith(workers.create);
  await expectCrashAndRecovery(
    engine,
    () => {
      workers.state.armed = true;
    },
    /wasm-trap/,
  );
  expect(workers.state.created).toBe(2);
});

test('wasm 記憶體用完（avcodec_send_packet 回傳 AVERROR(ENOMEM)）：error 為 INTERNAL（out-of-memory）', async () => {
  // emscripten 的 errno 沿用 WASI：ENOMEM 是 48。
  const workers = inPageWorkers(await exportName('avcodec_send_packet'), () => -48);
  engine = engineWith(workers.create);
  await expectCrashAndRecovery(
    engine,
    () => {
      workers.state.armed = true;
    },
    /out-of-memory/,
  );
});

test('Worker 的 script 載入失敗：load 以 fatal 的 ASSET_LOAD_FAILED reject', async () => {
  const NativeWorker = Worker;
  // createWebMediaWorker 的字面寫法不變，只把載入的 script 換成不存在的檔案。
  vi.stubGlobal(
    'Worker',
    class extends NativeWorker {
      constructor(_url: string | URL, options?: WorkerOptions) {
        super(new URL('/kikoeru-missing-worker.js', location.href), options);
      }
    },
  );
  engine = createEngine();
  await expect(engine.load(source)).rejects.toMatchObject({
    name: 'EngineError',
    code: 'ASSET_LOAD_FAILED',
    fatal: true,
  });
  expect(engine.state).toBe('error');
});
