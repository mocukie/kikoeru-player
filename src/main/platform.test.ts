import { describe, expect, it } from 'vitest';
import { detectPlatform } from './platform.js';

const ua = {
  iPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iPhoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  // iPadOS 的 Safari 預設以桌面版 UA 回報，只能靠觸控點數與 Mac 區分。
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
};

describe('detectPlatform', () => {
  it.each([
    ['iPhone 的 Safari', ua.iPhone, 5, 'ios'],
    ['iPhone 的 Chrome', ua.iPhoneChrome, 5, 'ios'],
    ['iPadOS（桌面版 UA、有觸控）', ua.macSafari, 5, 'ios'],
    ['Mac 的 Safari（沒有觸控）', ua.macSafari, 0, 'desktop'],
    ['Android 的 Chrome', ua.androidChrome, 5, 'android'],
    ['Android 的 Firefox', ua.androidFirefox, 5, 'android'],
    ['有觸控螢幕的 Windows', ua.windowsChrome, 10, 'desktop'],
    ['Linux 的 Firefox', ua.linuxFirefox, 0, 'desktop'],
  ] as const)('%s → %s', (_, userAgent, maxTouchPoints, expected) => {
    expect(detectPlatform({ userAgent, maxTouchPoints })).toBe(expected);
  });

  it('沒有 maxTouchPoints 時，Mac 的 UA 視為桌面', () => {
    expect(detectPlatform({ userAgent: ua.macSafari })).toBe('desktop');
  });

  it('iPhone 的 UA 不看觸控點數', () => {
    expect(detectPlatform({ userAgent: ua.iPhone })).toBe('ios');
    expect(detectPlatform({ userAgent: ua.iPhone, maxTouchPoints: 0 })).toBe('ios');
  });

  it('沒有 navigator 時視為桌面', () => {
    expect(detectPlatform(undefined)).toBe('desktop');
  });
});
