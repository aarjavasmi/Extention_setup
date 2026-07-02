// offscreen.js — captures tab audio and transcribes it locally with Whisper (transformers.js).
// Runs in the extension's offscreen document. No audio ever leaves the machine.

// transformers.js is loaded lazily so the message listener below registers
// immediately — otherwise the background's first message can arrive before
// this page is ready ("Receiving end does not exist").
let tfPromise = null;
function loadTransformers() {
  if (!tfPromise) {
    tfPromise = import('./libs/transformers.min.js').then((m) => {
      // Serve onnxruntime wasm from the extension bundle (no remote code).
      m.env.allowLocalModels = false;
      m.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('libs/');
      return m;
    });
  }
  return tfPromise;
}

// Multilingual model — handles English, Hindi, and Hinglish lectures.
// Swap to 'onnx-community/whisper-tiny.en' (smaller/faster) for English-only,
// or 'onnx-community/whisper-small' (~250 MB) for higher accuracy on a GPU machine.
const WHISPER_MODEL = 'onnx-community/whisper-base';
const CHUNK_SECONDS = 30;        // Whisper's native window
const TARGET_SAMPLE_RATE = 16000;
const SILENCE_RMS = 0.0025;      // skip near-silent chunks (whisper hallucinates on silence)

let transcriber = null;
let audioCtx = null;
let playbackCtx = null;
let mediaStream = null;
let workletNode = null;

let sampleRate = 48000;          // actual rate, set when capture starts
let pcmBuffer = [];              // Float32Array blocks
let pcmLength = 0;

let chunkQueue = [];             // Float32Array chunks awaiting transcription
let processing = false;
let transcriptParts = [];        // { text } in order
let capturing = false;

function reportStatus(status, detail = '') {
  chrome.runtime.sendMessage({ type: 'WHISPER_STATUS', status, detail }).catch(() => {});
}

// Aggregate download progress across model files, throttled to 2 updates/sec.
const dlProgress = {};
let lastProgressReport = 0;
function onModelProgress(p) {
  if (p.status !== 'progress' || !p.total) return;
  dlProgress[p.file] = [p.loaded, p.total];
  const now = Date.now();
  if (now - lastProgressReport < 500) return;
  lastProgressReport = now;
  let loaded = 0, total = 0;
  for (const f in dlProgress) { loaded += dlProgress[f][0]; total += dlProgress[f][1]; }
  const pct = Math.min(99, Math.round((100 * loaded) / total));
  reportStatus('loading-model', `Downloading Whisper model… ${pct}% (first run only)`);
}

async function loadModel() {
  if (transcriber) return;
  reportStatus('loading-model', 'Preparing Whisper model…');
  const { pipeline } = await loadTransformers();
  try {
    transcriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      device: 'webgpu',
      dtype: 'fp32',
      progress_callback: onModelProgress,
    });
    reportStatus('ready', 'Whisper ready (WebGPU)');
  } catch (e) {
    console.warn('WebGPU unavailable, falling back to WASM:', e);
    transcriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: onModelProgress,
    });
    reportStatus('ready', 'Whisper ready (CPU)');
  }
}

async function startCapture(streamId) {
  if (capturing) return;
  await loadModel();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // 1) Pass audio through so the user still hears the tab (capture mutes it otherwise).
  playbackCtx = new AudioContext();
  playbackCtx.createMediaStreamSource(mediaStream).connect(playbackCtx.destination);
  await playbackCtx.resume().catch(() => {});

  // 2) Collect PCM for Whisper.
  audioCtx = new AudioContext();
  sampleRate = audioCtx.sampleRate;
  await audioCtx.audioWorklet.addModule('pcm-worklet.js');
  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-collector');
  workletNode.port.onmessage = (e) => onPCM(e.data);
  source.connect(workletNode);
  // Worklet needs a destination connection in some Chrome versions; use a muted gain.
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  workletNode.connect(mute).connect(audioCtx.destination);

  await audioCtx.resume().catch(() => {});
  capturing = true;
  reportStatus('capturing', 'Listening to tab audio');
}

function onPCM(block) {
  if (!capturing) return;
  pcmBuffer.push(block);
  pcmLength += block.length;
  if (pcmLength >= CHUNK_SECONDS * sampleRate) flushBuffer();
}

function flushBuffer() {
  if (pcmLength === 0) return;
  const merged = new Float32Array(pcmLength);
  let offset = 0;
  for (const b of pcmBuffer) { merged.set(b, offset); offset += b.length; }
  pcmBuffer = [];
  pcmLength = 0;
  chunkQueue.push(merged);
  processQueue();
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (chunkQueue.length > 0) {
      const chunk = chunkQueue.shift();
      if (rms(chunk) < SILENCE_RMS) continue; // skip silence/paused stretches
      const audio = downsample(chunk, sampleRate, TARGET_SAMPLE_RATE);
      try {
        const result = await transcriber(audio);
        const text = (result.text || '').trim();
        if (text) transcriptParts.push(text);
      } catch (e) {
        console.error('Transcription chunk failed:', e);
      }
    }
  } finally {
    processing = false;
  }
}

async function drainAndGetTranscript() {
  flushBuffer();                      // include the partial chunk at checkpoint time
  await processQueue();               // no-op if already running…
  while (processing || chunkQueue.length > 0) {   // …so wait until the queue empties
    await new Promise((r) => setTimeout(r, 500));
  }
  const text = transcriptParts.join(' ');
  transcriptParts = [];               // reset window for the next 10-minute segment
  return text;
}

function stopCapture() {
  capturing = false;
  try { workletNode && workletNode.disconnect(); } catch (e) {}
  try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { audioCtx && audioCtx.close(); } catch (e) {}
  try { playbackCtx && playbackCtx.close(); } catch (e) {}
  workletNode = null; mediaStream = null; audioCtx = null; playbackCtx = null;
  pcmBuffer = []; pcmLength = 0; chunkQueue = []; transcriptParts = [];
  reportStatus('stopped');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;

  if (message.type === 'OFFSCREEN_START') {
    startCapture(message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => { reportStatus('error', String(e)); sendResponse({ ok: false, error: String(e) }); });
    return true;
  }

  if (message.type === 'GET_TRANSCRIPT') {
    drainAndGetTranscript()
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message.type === 'OFFSCREEN_STOP') {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }
});
