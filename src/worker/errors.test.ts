import { describe, expect, test } from 'vitest';
import { crashReason, WorkerError } from './errors.js';

describe('crashReason', () => {
  test('wasm trap', () => {
    expect(crashReason(new WebAssembly.RuntimeError('unreachable'))).toBe('wasm-trap');
    // emscripten 的 abort() 也是 RuntimeError，訊息帶 OOM 時是記憶體用完。
    expect(crashReason(new WebAssembly.RuntimeError('Aborted(OOM)'))).toBe('out-of-memory');
  });

  test.each([
    // emscripten 的 writeoutEmscriptenOOM。
    'Out of memory',
    // libav.js 以 ff_error() 轉 FFmpeg 的 AVERROR(ENOMEM)（musl 的 strerror）。
    'Error submitting the packet to the decoder: Out of memory',
    'Cannot allocate memory',
    // V8 配置不到 ArrayBuffer（例如複製解出的 frame）。
    'Array buffer allocation failed',
  ])('記憶體用完：%s', (message) => {
    expect(crashReason(new Error(message))).toBe('out-of-memory');
    expect(crashReason(new RangeError(message))).toBe('out-of-memory');
  });

  test('可分類的錯誤與一般的錯誤不是崩潰', () => {
    // 建立 instance 時配置不到記憶體是這個 load 的 MEMORY_LIMIT，Worker 仍可使用。
    expect(crashReason(new WorkerError('MEMORY_LIMIT', 'Out of memory'))).toBeNull();
    expect(crashReason(new Error('Error submitting the packet to the decoder: Invalid data'))).toBe(
      null,
    );
    expect(crashReason('Out of memory')).toBeNull();
  });
});
