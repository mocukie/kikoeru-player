import { describe, expect, it } from 'vitest';
import { EngineError, isAbortError } from './errors.js';

describe('EngineError', () => {
  it('帶著 code、fatal、position 與 detail', () => {
    const error = new EngineError('SOURCE_UNAUTHORIZED', {
      fatal: true,
      position: 12.5,
      detail: { status: 401, url: 'https://example.test/a.flac' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EngineError);
    expect(error.name).toBe('EngineError');
    expect(error.code).toBe('SOURCE_UNAUTHORIZED');
    expect(error.fatal).toBe(true);
    expect(error.position).toBe(12.5);
    expect(error.detail).toEqual({ status: 401, url: 'https://example.test/a.flac' });
  });

  it('沒有 message 時以 code 當 message', () => {
    const error = new EngineError('DESTROYED', { fatal: false, position: 0 });

    expect(error.message).toBe('DESTROYED');
    expect(String(error)).toBe('EngineError: DESTROYED');
  });

  it('保留 message 與 cause', () => {
    const cause = new TypeError('Failed to fetch');
    const error = new EngineError('SOURCE_NETWORK', {
      fatal: true,
      position: 3,
      message: '重試 3 次後仍無法連線',
      cause,
    });

    expect(error.message).toBe('重試 3 次後仍無法連線');
    expect(error.cause).toBe(cause);
  });

  it('沒有 detail 與 cause 時，detail 是空物件、cause 不存在', () => {
    const error = new EngineError('INTERNAL', { fatal: true, position: 0 });

    expect(error.detail).toEqual({});
    expect('cause' in error).toBe(false);
  });

  it('不受建立後修改傳入的 detail 影響', () => {
    const detail = { trackId: 'a:1' };
    const error = new EngineError('CODEC_UNSUPPORTED', { fatal: false, position: 0, detail });
    detail.trackId = 'a:2';

    expect(error.detail.trackId).toBe('a:1');
  });

  it('不是 AbortError', () => {
    expect(isAbortError(new EngineError('DESTROYED', { fatal: false, position: 0 }))).toBe(false);
  });
});

describe('isAbortError', () => {
  it('被取代的指令所用的 DOMException AbortError 為 true', () => {
    expect(isAbortError(new DOMException('superseded', 'AbortError'))).toBe(true);
  });

  it('AbortSignal 中止時的 reason 為 true', () => {
    const controller = new AbortController();
    controller.abort();

    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it('name 為 AbortError 的 Error 也為 true', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';

    expect(isAbortError(error)).toBe(true);
  });

  it.each([
    ['其他 DOMException', new DOMException('timeout', 'TimeoutError')],
    ['一般 Error', new Error('AbortError')],
    ['字串', 'AbortError'],
    ['null', null],
    ['undefined', undefined],
  ])('%s 為 false', (_, value) => {
    expect(isAbortError(value)).toBe(false);
  });
});
