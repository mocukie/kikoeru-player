// 內嵌字幕的封包轉成 cue：文字字幕取原始文字，ASS／SSA 保留 Matroska 封包原文並依 header 的 Format 重組 Dialogue 行。
import { describe, expect, test } from 'vitest';
import { cueReader } from './subtitles.js';

const utf8 = (text: string) => new TextEncoder().encode(text);

/** FFmpeg 寫出的 V4+ header（節錄）。 */
const assHeader =
  '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,sans-serif\n\n' +
  '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

describe('文字字幕', () => {
  test('subrip：封包內的原始文字，不解析標記；起訖取自封包的時間與時長', () => {
    const read = cueReader({ format: 'subrip' });
    const cue = read({ time: 3, duration: 0.5, data: utf8('<i>第3秒</i>\n二行目') });
    expect(cue).toMatchObject({
      format: 'subrip',
      start: 3,
      end: 3.5,
      text: '<i>第3秒</i>\n二行目',
    });
  });

  test('webvtt：封包內的 cue 文字', () => {
    const read = cueReader({ format: 'webvtt' });
    expect(read({ time: 1, duration: 0.5, data: utf8('<v Bob>hi') })).toMatchObject({
      format: 'webvtt',
      text: '<v Bob>hi',
    });
  });

  test('mov_text：取 16-bit 長度之後的文字，不含之後的 style box', () => {
    const read = cueReader({ format: 'mov_text' });
    const text = utf8('嗶');
    const styl = [0, 0, 0, 12, 0x73, 0x74, 0x79, 0x6c, 0, 0, 0, 0];
    const data = Uint8Array.from([0, text.length, ...text, ...styl]);
    expect(read({ time: 0, duration: 0.5, data })).toMatchObject({
      format: 'mov_text',
      text: '嗶',
    });
  });

  test('mov_text 用來清空畫面的空 sample 不是 cue', () => {
    const read = cueReader({ format: 'mov_text' });
    expect(read({ time: 0.5, duration: 0.5, data: Uint8Array.from([0, 0]) })).toBeNull();
  });

  test('沒有時間戳的封包不是 cue', () => {
    const read = cueReader({ format: 'subrip' });
    expect(read({ time: null, duration: 0.5, data: utf8('x') })).toBeNull();
  });

  test('id 只由封包的內容決定：同一個封包再讀一次（seek 後重送）id 相同，同時開始的不同 cue id 不同', () => {
    const read = cueReader({ format: 'subrip' });
    const a = read({ time: 2, duration: 1, data: utf8('上') });
    const again = cueReader({ format: 'subrip' })({ time: 2, duration: 1, data: utf8('上') });
    const b = read({ time: 2, duration: 1, data: utf8('下') });
    expect(again?.id).toBe(a?.id);
    expect(b?.id).not.toBe(a?.id);
  });
});

describe('ASS／SSA', () => {
  const raw = '7,1,Default,Alice,0,0,20,,{\\fad(50,50)}你好，世界, 2';

  test('raw 是封包原文，readOrder 取自原文，dialogue 依 header 的 Format 重組', () => {
    const read = cueReader({ format: 'ass', header: assHeader });
    const cue = read({ time: 61.234, duration: 1.5, data: utf8(raw) });
    expect(cue).toEqual({
      format: 'ass',
      id: '61234000:7',
      start: 61.234,
      end: 62.734,
      raw,
      readOrder: 7,
      dialogue:
        'Dialogue: 1,0:01:01.23,0:01:02.73,Default,Alice,0,0,20,,{\\fad(50,50)}你好，世界, 2',
    });
  });

  test('id 由 pts 與 ReadOrder 組成：同一個時間的不同 event 以 ReadOrder 區分', () => {
    const read = cueReader({ format: 'ass', header: assHeader });
    const a = read({ time: 1, duration: 1, data: utf8('3,0,Default,,0,0,0,,a') });
    const b = read({ time: 1, duration: 1, data: utf8('4,0,Default,,0,0,0,,b') });
    expect([a?.id, b?.id]).toEqual(['1000000:3', '1000000:4']);
  });

  test('Format 的欄位順序與 Matroska 不同時依 header 排列；header 沒有的欄位不輸出', () => {
    const header = '[Events]\nFormat: Start, End, Style, Layer, Text\n';
    const read = cueReader({ format: 'ass', header });
    const cue = read({ time: 3600, duration: 0.01, data: utf8('0,2,Sign,,0,0,0,,a,b') });
    expect(cue && 'dialogue' in cue && cue.dialogue).toBe(
      'Dialogue: 1:00:00.00,1:00:00.01,Sign,2,a,b',
    );
  });

  test('SSA 的 Marked 欄位以 Matroska 的 Layer 填入', () => {
    const header =
      '[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    const read = cueReader({ format: 'ssa', header });
    const cue = read({ time: 0, duration: 2, data: utf8('0,0,Default,,0000,0000,0000,,hi') });
    expect(cue).toMatchObject({
      format: 'ssa',
      dialogue: 'Dialogue: Marked=0,0:00:00.00,0:00:02.00,Default,,0000,0000,0000,,hi',
    });
  });

  test('header 沒有 [Events] 的 Format 時使用 V4+ 的標準 Format', () => {
    const read = cueReader({ format: 'ass', header: '[Script Info]\nScriptType: v4.00+\n' });
    const cue = read({ time: 0, duration: 1, data: utf8('0,0,Default,,0,0,0,,x') });
    expect(cue && 'dialogue' in cue && cue.dialogue).toBe(
      'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,x',
    );
  });

  test('Format 行的大小寫、空白與 CRLF 不影響對應', () => {
    const header =
      '[Events]\r\nformat:layer,start ,END,Style,Name,MarginL,MarginR,MarginV,Effect,TEXT\r\n';
    const read = cueReader({ format: 'ass', header });
    const cue = read({ time: 0, duration: 1, data: utf8('0,5,Default,,0,0,0,,x') });
    expect(cue && 'dialogue' in cue && cue.dialogue).toBe(
      'Dialogue: 5,0:00:00.00,0:00:01.00,Default,,0,0,0,,x',
    );
  });
});
