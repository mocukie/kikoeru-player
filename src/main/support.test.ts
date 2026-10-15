import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEngineSupported } from './support.js';

// Node 有 WebAssembly，沒有 Worker、AudioContext 與 AudioWorkletNode；以 stub 模擬瀏覽器。
function stubBrowser(): void {
  // 瀏覽器的 audioWorklet 是 BaseAudioContext.prototype 上的 getter。
  class FakeAudioContext {
    get audioWorklet(): object {
      return {};
    }
  }
  vi.stubGlobal('Worker', vi.fn());
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', vi.fn());
}

describe('isEngineSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有 WebAssembly、Worker 與 AudioWorklet 時為 true', () => {
    stubBrowser();

    expect(isEngineSupported()).toBe(true);
  });

  it('不要求 WebCodecs', () => {
    stubBrowser();
    vi.stubGlobal('VideoDecoder', undefined);

    expect(isEngineSupported()).toBe(true);
  });

  it.each(['WebAssembly', 'Worker', 'AudioContext', 'AudioWorkletNode'])(
    '缺少 %s 時為 false',
    (name) => {
      stubBrowser();
      vi.stubGlobal(name, undefined);

      expect(isEngineSupported()).toBe(false);
    },
  );

  it('沒有 AudioWorklet 的 AudioContext（非 secure context）為 false', () => {
    stubBrowser();
    vi.stubGlobal('AudioContext', vi.fn());

    expect(isEngineSupported()).toBe(false);
  });

  it('Node 本身不支援', () => {
    expect(isEngineSupported()).toBe(false);
  });
});
