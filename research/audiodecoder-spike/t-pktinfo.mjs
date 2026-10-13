// 拋棄式 spike（#18）：列出每個檔案頭尾幾個封包的 pts／duration／flags（AV_PKT_FLAG_DISCARD = 4）與 skip side data。
import { createLibAV } from "./lib.mjs";
import { openAudio, readAllPackets, skipInfo, usOf } from "./audio.mjs";

export async function run({ files = ["acc-aac.m4a", "acc-fdk.m4a", "acc-mp3.mp3", "acc-opus.opus", "acc-opus.webm", "acc-vorbis.ogg", "acc-vorbis.webm"] } = {}) {
  const lib = await createLibAV();
  const out = {};
  for (const f of files) {
    const o = await openAudio(lib, `/media/${f}`);
    const pk = await readAllPackets(lib, o.fmt, o.info.index);
    const show = (p, i) => ({ i, us: usOf(o.info, p), dur: p.duration, flags: p.flags, skip: skipInfo(p) });
    out[f] = { head: pk.slice(0, 3).map((p, i) => show(p, i)), tail: pk.slice(-2).map((p, i) => show(p, pk.length - 2 + i)),
      discardFlagged: pk.filter((p) => p.flags & 4).length };
    await lib.avformat_close_input_js(o.fmt);
  }
  return out;
}
