// 診斷 log（#45）：等級過濾、Worker 與 worklet 的 log 轉送與時基換算、沒有 hook 時不讓其他執行緒送 log。
// 以假 media Worker 與假音訊輸出驅動 createEngineWith()。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps } from '../../test/fakes/engine-deps.js';
import { audioMedia } from '../../test/fakes/media-worker.js';
import { createEngineWith } from './engine.js';
import type { EngineOptions, LogEntry, LogLevel, Source } from './types.js';

const source: Source = { kind: 'http', url: 'https://example.test/a.flac' };

afterEach(() => {
  vi.restoreAllMocks();
});

async function loaded(engineOptions?: EngineOptions) {
  const deps = createFakeDeps();
  const engine = createEngineWith(deps, engineOptions);
  const loading = engine.load(source);
  const worker = deps.workers.last;
  await worker.probe(audioMedia({ duration: 10 }));
  await worker.next('start');
  deps.audio.reply({ type: 'paused' });
  await loading;
  return { engine, deps, worker };
}

function collect(level?: LogLevel) {
  const entries: LogEntry[] = [];
  const options: EngineOptions = {
    log: (entry) => {
      entries.push(entry);
    },
    ...(level && { logLevel: level }),
  };
  return { entries, options };
}

describe('沒有 log hook', () => {
  it('Worker 與 worklet 都被告知不送 log', async () => {
    const { deps, worker } = await loaded();
    expect(deps.audio.config.logLevel).toBeNull();
    expect((await worker.next('init')).logLevel).toBeNull();
  });

  it('其他執行緒仍送來的 log 也不會出錯', async () => {
    const { deps, worker } = await loaded();
    worker.reply({
      type: 'log',
      entry: { level: 'error', scope: 'io', message: 'x', time: performance.timeOrigin },
    });
    deps.audio.emitLog({ level: 'error', scope: 'audio', message: 'y', time: 0 });
  });
});

describe('等級過濾', () => {
  it('Worker 與 worklet 收到 logLevel；預設為 warn', async () => {
    const { options } = collect();
    const { deps, worker } = await loaded(options);
    expect(deps.audio.config.logLevel).toBe('warn');
    expect((await worker.next('init')).logLevel).toBe('warn');
  });

  it('logLevel 為 debug 時 Engine 自己的 debug log（指令、state）也送進 hook', async () => {
    const { entries, options } = collect('debug');
    await loaded(options);
    expect(entries.some((e) => e.level === 'debug' && e.scope === 'command')).toBe(true);
    expect(entries.every((e) => typeof e.time === 'number' && e.message.length > 0)).toBe(true);
  });

  it('預設的 warn 不送出 debug 與 info', async () => {
    const { entries, options } = collect();
    await loaded(options);
    expect(entries).toEqual([]);
  });

  it('低於 logLevel 的 Worker log 被丟掉', async () => {
    const { entries, options } = collect('warn');
    const { worker } = await loaded(options);
    const time = performance.timeOrigin + 10;
    worker.reply({ type: 'log', entry: { level: 'info', scope: 'io', message: 'skip', time } });
    worker.reply({ type: 'log', entry: { level: 'warn', scope: 'io', message: 'keep', time } });
    expect(entries.map((e) => e.message)).toEqual(['keep']);
  });

  it('logLevel 不是四個等級之一時丟 RangeError', () => {
    expect(() => createEngineWith(createFakeDeps(), { logLevel: 'verbose' as LogLevel })).toThrow(
      RangeError,
    );
  });
});

describe('轉送與時基', () => {
  it('Worker 的 time（timeOrigin 加 performance.now()）換算成主執行緒的 performance.now()', async () => {
    const { entries, options } = collect('debug');
    const { worker } = await loaded(options);
    entries.length = 0;
    worker.reply({
      type: 'log',
      entry: {
        level: 'warn',
        scope: 'io',
        message: 'HTTP 503，重試',
        time: performance.timeOrigin + 1234.5,
        data: { status: 503 },
      },
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        scope: 'io',
        message: 'HTTP 503，重試',
        time: expect.closeTo(1234.5, 3) as number,
        data: { status: 503 },
      },
    ]);
  });

  it('被 terminate 的 Worker 送來的 log 也照常轉送', async () => {
    const { entries, options } = collect('debug');
    const { engine, deps, worker } = await loaded(options);
    const loading = engine.load(source);
    entries.length = 0;
    worker.reply({
      type: 'log',
      entry: { level: 'debug', scope: 'demux', message: 'late', time: performance.timeOrigin },
    });
    expect(entries.map((e) => e.message)).toEqual(['late']);
    await deps.workers.last.probe(audioMedia());
    await deps.workers.last.next('start');
    deps.audio.reply({ type: 'paused' });
    await loading;
  });

  it('worklet 的 log（音訊輸出已換算時基）原樣送進 hook', async () => {
    const { entries, options } = collect('debug');
    const { deps } = await loaded(options);
    entries.length = 0;
    deps.audio.emitLog({
      level: 'warn',
      scope: 'audio',
      message: 'ring 用完',
      time: 42,
      data: { position: 3 },
    });
    expect(entries).toEqual([
      { level: 'warn', scope: 'audio', message: 'ring 用完', time: 42, data: { position: 3 } },
    ]);
  });

  it('hook 丟出的錯誤不影響 Engine', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
    const { engine } = await loaded({
      logLevel: 'debug',
      log: () => {
        throw new Error('hook 壞掉');
      },
    });
    expect(engine.state).toBe('ready');
    expect(reported.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe('各子系統的事件', () => {
  it('致命錯誤以 error 等級記錄，帶錯誤碼', async () => {
    const { entries, options } = collect('error');
    const { worker } = await loaded(options);
    worker.reply({
      type: 'error',
      epoch: (await worker.next('start')).epoch,
      error: { code: 'SOURCE_NOT_FOUND', fatal: true, message: '404' },
    });
    expect(entries).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'io',
        data: expect.objectContaining({ code: 'SOURCE_NOT_FOUND' }) as unknown,
      }),
    ]);
  });

  it('指令被取代時記錄 debug', async () => {
    const { entries, options } = collect('debug');
    const { engine, deps } = await loaded(options);
    const first = engine.seek(1);
    const second = engine.seek(2);
    await expect(first).rejects.toThrow();
    expect(entries.some((e) => e.scope === 'command' && e.message.includes('取代'))).toBe(true);
    deps.audio.reply({ type: 'paused' });
    await second;
  });
});
