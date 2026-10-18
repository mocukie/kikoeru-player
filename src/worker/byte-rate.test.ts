import { describe, expect, test } from 'vitest';
import { ByteRate, initialByteRate } from './byte-rate.js';

describe('initialByteRate', () => {
  test('所有音訊與影片軌都有 bit_rate 時用它們的合計', () => {
    expect(
      initialByteRate({
        size: 10_000_000,
        duration: 10,
        bitRates: [1_536_000, 8_000_000],
      }),
    ).toBe(1_192_000);
  });

  test('有軌道沒有 bit_rate 時用「大小 ÷ duration」', () => {
    expect(initialByteRate({ size: 1_000_000, duration: 10, bitRates: [128_000, 0] })).toBe(
      100_000,
    );
  });

  test('兩者都沒有時用保守的預設值', () => {
    expect(initialByteRate({ size: 1_000_000, duration: NaN, bitRates: [] })).toBe(256 * 1024);
  });
});

describe('ByteRate', () => {
  test('一開始是初始估計', () => {
    expect(new ByteRate(1000).value).toBe(1000);
  });

  test('連續 demux 超過 2 秒後，改用讀到的 byte 位置與 pts 算出的位元組率', () => {
    const rate = new ByteRate(1000);
    rate.observe(10_000, 0);
    rate.observe(13_000, 1);
    expect(rate.value).toBe(1000);
    rate.observe(18_000, 2.5);
    expect(rate.value).toBe(3200);
    rate.observe(28_000, 5);
    expect(rate.value).toBe(3600);
  });

  test('位置或時間倒退（seek）時從那裡重新累計；之前修正過的值沿用到累計夠長', () => {
    const rate = new ByteRate(1000);
    rate.observe(0, 0);
    rate.observe(6000, 3);
    expect(rate.value).toBe(2000);
    rate.observe(100, 0.5);
    rate.observe(4100, 1.5);
    expect(rate.value).toBe(2000);
    rate.observe(12_100, 3.5);
    expect(rate.value).toBe(4000);
  });

  test('reset() 之後重新累計', () => {
    const rate = new ByteRate(1000);
    rate.observe(0, 0);
    rate.reset();
    rate.observe(50_000, 10);
    rate.observe(52_000, 12);
    expect(rate.value).toBe(1000);
  });
});
