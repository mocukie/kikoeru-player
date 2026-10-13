// 拋棄式 spike（#18）：在主執行緒對每個 codec 建一個 AudioDecoder 解幾個封包，讓 Chromium 的 CDP Media domain
// 吐出 media log（kAudioDecoderName、kIsPlatformAudioDecoder）。runner 要帶 {"cdpMedia":true}。
import { createLibAV } from "./lib.mjs";
import { openAudio, readAllPackets, adDecode, adConfig } from "./audio.mjs";

const FILES = ["acc-aac.m4a", "acc-mp3.mp3", "acc-opus.opus", "acc-flac.flac", "acc-vorbis.ogg", "cs-pcm-s24-96k.wav", "cs-ac3-6ch.ac3"];

export async function run({ files = FILES } = {}, log) {
  const lib = await createLibAV();
  const out = {};
  for (const f of files) {
    const o = await openAudio(lib, `/media/${f}`);
    const pk = (await readAllPackets(lib, o.fmt, o.info.index)).slice(0, 20);
    const a = await adDecode(o.info, pk, { config: adConfig(o.info), keep: false });
    out[f] = { codec: adConfig(o.info).codec, error: a.error, outputs: a.meta.length };
    log(`${f} ${JSON.stringify(out[f])}`);
    await lib.avformat_close_input_js(o.fmt);
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}
