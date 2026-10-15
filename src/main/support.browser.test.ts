import { expect, test } from 'vitest';
import { isEngineSupported } from './support.js';

test('支援的瀏覽器上為 true', () => {
  expect(isEngineSupported()).toBe(true);
});
