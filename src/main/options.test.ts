import { describe, expect, it } from 'vitest';
import { resolveEngineOptions } from './options.js';
import type { EngineOptions } from './types.js';

const MiB = 1024 * 1024;

describe('resolveEngineOptions：預設值', () => {
  it('桌面：沒有任何選項時全部補上預設值', () => {
    expect(resolveEngineOptions(undefined, 'desktop')).toEqual({
      platform: 'desktop',
      assets: {},
      canvas: null,
      timeUpdateInterval: 250,
      limits: { cacheBytes: 128 * MiB, readaheadSeconds: 60, packetQueueBytes: 64 * MiB },
      retry: { attempts: 3, baseDelayMs: 500 },
      stallTimeout: 8000,
      stallAttempts: 2,
      preferredLanguages: { audio: [], subtitle: [] },
      suspendVideoWhenHidden: true,
      audioBuffer: { targetMs: 150, refillMs: 75, capacityMs: 400 },
      audioFadeMs: 10,
      log: null,
      logLevel: 'warn',
    });
  });

  it.each([
    ['desktop', { targetMs: 150, refillMs: 75, capacityMs: 400 }, 128 * MiB, 64 * MiB],
    ['android', { targetMs: 250, refillMs: 125, capacityMs: 600 }, 64 * MiB, 32 * MiB],
    ['ios', { targetMs: 300, refillMs: 150, capacityMs: 750 }, 64 * MiB, 32 * MiB],
  ] as const)(
    '%s 的 audioBuffer、cacheBytes 與封包佇列的硬上限',
    (platform, audioBuffer, cacheBytes, packetQueueBytes) => {
      const resolved = resolveEngineOptions({}, platform);

      expect(resolved.platform).toBe(platform);
      expect(resolved.audioBuffer).toEqual(audioBuffer);
      expect(resolved.limits).toEqual({ cacheBytes, readaheadSeconds: 60, packetQueueBytes });
    },
  );

  it('保留 App 給的值', () => {
    const log = () => undefined;
    const wasmUrl = new URL('https://example.test/libav.wasm');
    const resolved = resolveEngineOptions(
      {
        assets: { wasmUrl, glueUrl: '/libav.wasm.mjs' },
        timeUpdateInterval: 100,
        limits: { cacheBytes: 32 * MiB, readaheadSeconds: 30 },
        retry: { attempts: 0, baseDelayMs: 0 },
        stallTimeout: 5000,
        stallAttempts: 0,
        preferredLanguages: { audio: ['ja'], subtitle: ['zh-Hant', 'zh'] },
        suspendVideoWhenHidden: false,
        audioBuffer: { targetMs: 200, refillMs: 100, capacityMs: 500 },
        audioFadeMs: 0,
        log,
        logLevel: 'debug',
      },
      'android',
    );

    expect(resolved).toEqual({
      platform: 'android',
      assets: { wasmUrl, glueUrl: '/libav.wasm.mjs' },
      canvas: null,
      timeUpdateInterval: 100,
      limits: { cacheBytes: 32 * MiB, readaheadSeconds: 30, packetQueueBytes: 32 * MiB },
      retry: { attempts: 0, baseDelayMs: 0 },
      stallTimeout: 5000,
      stallAttempts: 0,
      preferredLanguages: { audio: ['ja'], subtitle: ['zh-Hant', 'zh'] },
      suspendVideoWhenHidden: false,
      audioBuffer: { targetMs: 200, refillMs: 100, capacityMs: 500 },
      audioFadeMs: 0,
      log,
      logLevel: 'debug',
    });
  });

  it('巢狀選項只給部分欄位時，其餘補上預設值', () => {
    const resolved = resolveEngineOptions(
      {
        limits: { readaheadSeconds: 20 },
        retry: { attempts: 5 },
        preferredLanguages: { subtitle: ['ja'] },
      },
      'ios',
    );

    expect(resolved.limits).toEqual({
      cacheBytes: 64 * MiB,
      readaheadSeconds: 20,
      packetQueueBytes: 32 * MiB,
    });
    expect(resolved.retry).toEqual({ attempts: 5, baseDelayMs: 500 });
    expect(resolved.preferredLanguages).toEqual({ audio: [], subtitle: ['ja'] });
  });

  it('不受建立後修改傳入的偏好語言影響', () => {
    const audio = ['ja'];
    const resolved = resolveEngineOptions({ preferredLanguages: { audio } }, 'desktop');
    audio.push('en');

    expect(resolved.preferredLanguages.audio).toEqual(['ja']);
  });
});

describe('resolveEngineOptions：audioBuffer', () => {
  it.each([
    ['只給 targetMs', { targetMs: 200 }, { targetMs: 200, refillMs: 75, capacityMs: 400 }],
    ['只給 refillMs', { refillMs: 100 }, { targetMs: 150, refillMs: 100, capacityMs: 400 }],
    ['只給 capacityMs', { capacityMs: 1000 }, { targetMs: 150, refillMs: 75, capacityMs: 1000 }],
    [
      '給 target 與 capacity',
      { targetMs: 500, capacityMs: 900 },
      { targetMs: 500, refillMs: 75, capacityMs: 900 },
    ],
  ] as const)('桌面上%s：其餘以平台預設補上', (_, audioBuffer, expected) => {
    expect(resolveEngineOptions({ audioBuffer }, 'desktop').audioBuffer).toEqual(expected);
  });

  it('部分欄位以各平台自己的預設補上', () => {
    expect(resolveEngineOptions({ audioBuffer: { targetMs: 200 } }, 'ios').audioBuffer).toEqual({
      targetMs: 200,
      refillMs: 150,
      capacityMs: 750,
    });
  });

  it.each([
    ['refill 等於 target', { targetMs: 150, refillMs: 150, capacityMs: 400 }],
    ['refill 大於 target', { targetMs: 150, refillMs: 200, capacityMs: 400 }],
    ['target 等於 capacity', { targetMs: 400, refillMs: 75, capacityMs: 400 }],
    ['target 大於 capacity', { targetMs: 500, refillMs: 75, capacityMs: 400 }],
    ['補上預設後 refill 大於 target', { targetMs: 50 }],
    ['補上預設後 target 大於 capacity', { capacityMs: 100 }],
    ['refill 為 0', { refillMs: 0 }],
    ['refill 為負', { targetMs: 100, refillMs: -10, capacityMs: 200 }],
    ['NaN', { targetMs: Number.NaN }],
    ['Infinity', { capacityMs: Number.POSITIVE_INFINITY }],
  ] as const)('%s 時丟 RangeError', (_, audioBuffer) => {
    expect(() => resolveEngineOptions({ audioBuffer }, 'desktop')).toThrow(RangeError);
  });

  it('錯誤訊息指出生效的水位', () => {
    expect(() => resolveEngineOptions({ audioBuffer: { targetMs: 50 } }, 'desktop')).toThrow(
      /audioBuffer.*refillMs \(75\).*targetMs \(50\).*capacityMs \(400\)/,
    );
  });
});

describe('resolveEngineOptions：audioFadeMs', () => {
  it.each([0, 2.5, 10, 100])('%s 可以使用', (audioFadeMs) => {
    expect(resolveEngineOptions({ audioFadeMs }, 'desktop').audioFadeMs).toBe(audioFadeMs);
  });

  it.each([-1, 100.5, 1000, Number.NaN, Number.POSITIVE_INFINITY])(
    '%s 時丟 RangeError',
    (audioFadeMs) => {
      expect(() => resolveEngineOptions({ audioFadeMs }, 'desktop')).toThrow(RangeError);
      expect(() => resolveEngineOptions({ audioFadeMs }, 'desktop')).toThrow(/audioFadeMs/);
    },
  );
});

describe('resolveEngineOptions：其他數值的範圍', () => {
  it.each<[string, EngineOptions]>([
    ['timeUpdateInterval', { timeUpdateInterval: 0 }],
    ['timeUpdateInterval', { timeUpdateInterval: Number.NaN }],
    ['limits.cacheBytes', { limits: { cacheBytes: 0 } }],
    ['limits.cacheBytes', { limits: { cacheBytes: Number.POSITIVE_INFINITY } }],
    ['limits.readaheadSeconds', { limits: { readaheadSeconds: -1 } }],
    ['retry.attempts', { retry: { attempts: -1 } }],
    ['retry.attempts', { retry: { attempts: 1.5 } }],
    ['retry.baseDelayMs', { retry: { baseDelayMs: -1 } }],
    ['stallTimeout', { stallTimeout: 0 }],
    ['stallAttempts', { stallAttempts: -1 }],
    ['stallAttempts', { stallAttempts: Number.POSITIVE_INFINITY }],
  ])('%s 超出範圍時丟 RangeError 並指出選項名稱', (name, options) => {
    expect(() => resolveEngineOptions(options, 'desktop')).toThrow(RangeError);
    expect(() => resolveEngineOptions(options, 'desktop')).toThrow(name);
  });
});
