// minimal wasm: (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
self.onmessage = async () => {
  const r = {};
  try {
    const { instance } = await WebAssembly.instantiate(bytes);
    r.add = instance.exports.add(2, 40);
    r.streaming = typeof WebAssembly.instantiateStreaming;
    r.sab = typeof SharedArrayBuffer;
    r.coi = self.crossOriginIsolated;
    try { new WebAssembly.Memory({initial:1, maximum:2, shared:true}); r.sharedMemory = true; } catch(e){ r.sharedMemory = String(e); }
    r.simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
    r.videoDecoderInWorker = typeof VideoDecoder;
    r.audioDecoderInWorker = typeof AudioDecoder;
  } catch (e) { r.error = String(e); }
  self.postMessage(r);
};
