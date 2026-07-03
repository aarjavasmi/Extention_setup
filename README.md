# Lecture Checkpoint Quiz

Chrome extension that keeps you attentive during course videos. Every 10 minutes of playback it pauses the video and quizzes you with 3 AI-generated MCQs about what was just taught (active recall).

Works on **any site** with a video player. 100% free: audio is transcribed **locally in your browser** with Whisper (no audio leaves your machine), and questions are generated with the **Gemini free tier**.

## How it works

```
tab audio ──tabCapture──▶ offscreen page ──Whisper (local, transformers.js)──▶ rolling transcript
video playback ──content.js──▶ 10-min checkpoint ──▶ background.js ──▶ Gemini (free) ──▶ 3 MCQs ──▶ sidebar quiz
```

- `content.js` — tracks *watched* seconds on the page's main `<video>` (seek-proof); pauses at each 10-min mark
- `sidebar.js` — quiz UI: options, instant grading, explanations, score, Resume button
- `offscreen.js` + `pcm-worklet.js` — captures tab audio, passes it through so you still hear it, transcribes 30s chunks with `whisper-tiny.en` (WebGPU, falls back to CPU/WASM)
- `background.js` — orchestrates capture and calls Gemini with the last segment's transcript
- `popup/` — save your API key, start/stop monitoring

## Setup

1. Get a free Gemini API key at https://aistudio.google.com/apikey (no card required)
2. Make sure `config.js` has a valid key in `GEMINI_API_KEY` (it's committed to the repo — keep the repo **private**).
3. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder
4. Open your course video, click the extension icon → **Start monitoring this tab**, and play the video

First start downloads the Whisper model (~75 MB) from Hugging Face — one time only, then it's cached.

## Notes & limits

- Keep the video playing at 1x–1.5x; transcription runs in near real time (faster with WebGPU)
- The tab keeps playing audio during capture (passthrough); stopping monitoring restores normal audio
- Silence/paused stretches are skipped automatically
- Gemini free tier allows plenty of requests/day for a full study session; the key is stored in `chrome.storage.sync`, used only from your browser
- If a checkpoint has too little speech (e.g., you paused for 9 of the 10 minutes), it's skipped gracefully and the video resumes

## Free-resource stack

| Piece | Tool | Cost |
|---|---|---|
| Transcription | Whisper tiny.en via transformers.js, in-browser | Free, local |
| MCQ generation | Gemini 2.5 Flash free tier | Free |
| Everything else | Vanilla Chrome MV3 APIs | Free |
