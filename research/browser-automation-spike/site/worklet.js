class Sine extends AudioWorkletProcessor {
  constructor(){ super(); this.n=0; this.ph=0; }
  process(inputs, outputs){
    const out = outputs[0][0];
    for (let i=0;i<out.length;i++){ out[i]=0.1*Math.sin(this.ph); this.ph+=2*Math.PI*440/sampleRate; }
    this.n++;
    if (this.n % 50 === 0) this.port.postMessage(this.n);
    return true;
  }
}
registerProcessor('sine', Sine);
