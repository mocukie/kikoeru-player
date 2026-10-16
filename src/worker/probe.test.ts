import { describe, expect, test } from 'vitest';
import { hasPlayableTrack, toProbedMedia, type RawMedia, type RawStream } from './probe.js';

function stream(overrides: Partial<RawStream> = {}): RawStream {
  return {
    index: 0,
    type: 'audio',
    codec: 'aac',
    decodable: true,
    sampleRate: 48_000,
    channels: 2,
    channelMask: 0x3,
    sampleFormat: 'fltp',
    width: 0,
    height: 0,
    frameRate: null,
    metadata: {},
    disposition: 0,
    extradata: null,
    ...overrides,
  };
}

function media(streams: RawStream[], overrides: Partial<RawMedia> = {}): RawMedia {
  return { format: 'matroska,webm', duration: 20_021_000, size: 1234, streams, ...overrides };
}

describe('toProbedMedia', () => {
  test('容器的格式、大小與以秒表示的長度', () => {
    const probed = toProbedMedia(media([stream()]));
    expect(probed).toMatchObject({ format: 'matroska,webm', duration: 20.021, size: 1234 });
  });

  test('長度未知時為 NaN', () => {
    expect(toProbedMedia(media([stream()], { duration: null })).duration).toBeNaN();
  });

  test('音軌帶 codec、取樣率、聲道與 layout、原始取樣格式', () => {
    const [track] = toProbedMedia(
      media([
        stream({ index: 1, codec: 'flac', channels: 6, channelMask: 0x3f, sampleFormat: 's32' }),
      ]),
    ).tracks;
    expect(track).toEqual({
      kind: 'audio',
      streamIndex: 1,
      codec: 'flac',
      supported: true,
      default: false,
      forced: false,
      sampleRate: 48_000,
      channels: 6,
      channelLayout: '5.1',
      sampleFormat: 's32',
    });
  });

  test('PCM 的取樣格式取自 codec 名稱，例如 24-bit 為 s24', () => {
    const tracks = toProbedMedia(
      media([
        stream({ codec: 'pcm_s24le', sampleFormat: 's32' }),
        stream({ codec: 'pcm_f64le', sampleFormat: 'dbl' }),
        stream({ codec: 'pcm_u8', sampleFormat: 'u8' }),
      ]),
    ).tracks;
    expect(tracks.map((t) => (t.kind === 'audio' ? t.sampleFormat : null))).toEqual([
      's24',
      'f64',
      'u8',
    ]);
  });

  test('沒有 channel mask 時不給 layout', () => {
    const [track] = toProbedMedia(media([stream({ channelMask: 0 })])).tracks;
    expect(track).not.toHaveProperty('channelLayout');
  });

  test('wasm 沒有 decoder 的音軌標為不支援（codec）', () => {
    const [track] = toProbedMedia(media([stream({ codec: 'dts', decodable: false })])).tracks;
    expect(track).toMatchObject({ supported: false, unsupportedReason: 'codec' });
  });

  test('語言正規化為 BCP 47，並保留容器的原值', () => {
    const tracks = toProbedMedia(
      media([
        stream({ metadata: { language: 'jpn' } }),
        stream({ metadata: { language: 'chi' } }),
        stream({ metadata: { language: 'pt-BR' } }),
      ]),
    ).tracks;
    expect(tracks.map((t) => [t.language, t.rawLanguage])).toEqual([
      ['ja', 'jpn'],
      ['zh', 'chi'],
      ['pt-BR', 'pt-BR'],
    ]);
  });

  test("容器標 'und' 或無法對照的語言只保留原值", () => {
    const tracks = toProbedMedia(
      media([
        stream({ metadata: { language: 'und' } }),
        stream({ metadata: { language: '日本' } }),
      ]),
    ).tracks;
    expect(tracks.map((t) => [t.language, t.rawLanguage])).toEqual([
      [undefined, 'und'],
      [undefined, '日本'],
    ]);
    expect(tracks[0]).not.toHaveProperty('language');
  });

  test('標題、default 與 forced 旗標', () => {
    const [track] = toProbedMedia(
      media([stream({ metadata: { title: 'beep 880 Hz' }, disposition: 0x1 | 0x40 })]),
    ).tracks;
    expect(track).toMatchObject({ title: 'beep 880 Hz', default: true, forced: true });
  });

  test('影片軌依 Engine 支援的 codec 判斷', () => {
    const tracks = toProbedMedia(
      media([
        stream({ type: 'video', codec: 'h264', width: 320, height: 180, frameRate: 30 }),
        stream({ type: 'video', codec: 'mpeg4', decodable: false, width: 320, height: 180 }),
      ]),
    ).tracks;
    expect(tracks[0]).toEqual({
      kind: 'video',
      streamIndex: 0,
      codec: 'h264',
      supported: true,
      default: false,
      forced: false,
      codedWidth: 320,
      codedHeight: 180,
      display: { width: 320, height: 180, rotation: 0 },
      frameRate: 30,
    });
    expect(tracks[1]).toMatchObject({ supported: false, unsupportedReason: 'codec' });
    expect(tracks[1]).not.toHaveProperty('frameRate');
  });

  test('文字字幕帶格式，ASS 另帶 header；圖形字幕不支援', () => {
    const header = '[Script Info]\nScriptType: v4.00+\n';
    const tracks = toProbedMedia(
      media([
        stream({ type: 'subtitle', codec: 'subrip' }),
        stream({ type: 'subtitle', codec: 'ass', extradata: new TextEncoder().encode(header) }),
        stream({ type: 'subtitle', codec: 'hdmv_pgs_subtitle' }),
      ]),
    ).tracks;
    expect(tracks).toMatchObject([
      { kind: 'subtitle', format: 'subrip', supported: true },
      { kind: 'subtitle', format: 'ass', supported: true, header },
      {
        kind: 'subtitle',
        format: 'bitmap',
        supported: false,
        unsupportedReason: 'bitmap-subtitle',
      },
    ]);
  });

  test('不認得的字幕 codec、data 與附件串流不列為軌道', () => {
    const tracks = toProbedMedia(
      media([
        stream({ type: 'subtitle', codec: 'eia_608' }),
        stream({ type: 'other', codec: 'ttf' }),
        stream({ index: 2 }),
      ]),
    ).tracks;
    expect(tracks.map((t) => t.streamIndex)).toEqual([2]);
  });
});

describe('hasPlayableTrack', () => {
  test('有支援的音軌或影片軌才可以播放', () => {
    expect(hasPlayableTrack(toProbedMedia(media([stream()])))).toBe(true);
    expect(hasPlayableTrack(toProbedMedia(media([stream({ type: 'video', codec: 'h264' })])))).toBe(
      true,
    );
    expect(
      hasPlayableTrack(
        toProbedMedia(
          media([stream({ decodable: false }), stream({ type: 'subtitle', codec: 'subrip' })]),
        ),
      ),
    ).toBe(false);
  });
});
