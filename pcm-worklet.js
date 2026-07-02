// AudioWorklet processor: forwards raw PCM (mono Float32) blocks to the offscreen page.
class PCMCollector extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Copy — the underlying buffer is reused by the audio engine.
      this.port.postMessage(channel.slice(0));
    }
    return true; // keep processor alive
  }
}
registerProcessor('pcm-collector', PCMCollector);
