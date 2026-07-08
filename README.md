# Lecture Checkpoint Quiz

Chrome extension that keeps you attentive during course videos. It follows the lecture via a live local transcript, and once 3-4 subtopics have been fully explained it pauses the video and quizzes you with one AI-generated MCQ per subtopic (active recall).

Works on **any site** with a video player. 100% free: audio is transcribed **locally in your browser** with Whisper (no audio leaves your machine), and questions are generated with the **Gemini free tier**.

## How it works

```
tab audio ──tabCapture──▶ offscreen page ──Whisper (local, transformers.js)──▶ rolling transcript
video playback ──content.js──▶ evaluate every 2 min ──▶ background.js ──▶ Gemini decides: 3+ subtopics done? ──▶ 1 MCQ per subtopic ──▶ sidebar quiz
```

- `content.js` — tracks *watched* seconds on the page's main `<video>` (seek-proof); asks for an evaluation every 2 minutes without pausing
- `sidebar.js` — quiz UI: options, instant grading, explanations, score, Resume button
- `offscreen.js` + `pcm-worklet.js` — captures tab audio, passes it through so you still hear it, transcribes 30s chunks with `whisper-base` (multilingual: English/Hindi/Hinglish; WebGPU, falls back to CPU/WASM)
- `background.js` — orchestrates capture; asks Gemini whether 3+ subtopics are complete and, if so, gets one MCQ per subtopic
- `popup/` — start/stop monitoring (API key lives in `config.js`)

## Setup

1. Get a free Gemini API key at https://aistudio.google.com/apikey (no card required)
2. Copy `config.example.js` to `config.js` and paste your key into `GEMINI_API_KEY`. This file is gitignored — never commit it. 
3. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder
4. Open your course video, click the extension icon → **Start monitoring this tab**, and play the video

First start downloads the Whisper model (~75 MB) from Hugging Face — one time only, then it's cached.

## Notes & limits

- Keep the video playing at 1x–1.5x; transcription runs in near real time (faster with WebGPU)
- The tab keeps playing audio during capture (passthrough); stopping monitoring restores normal audio
- Silence/paused stretches are skipped automatically
- Gemini free tier (~1,500 requests/day) easily covers full study sessions at ~30 evaluations/hour; the key lives in `config.js` (gitignored) and is only used from your browser
- The video pauses ONLY when a quiz is ready — evaluations run silently in the background while you watch
- When the video ends, any remaining content gets a final quiz even if fewer than 3 subtopics completed
- A "Skip quiz" link is always available, and questions include per-subtopic tags, explanations, and a score
- YouTube ads get transcribed too and may occasionally influence questions (known limitation)

## Free-resource stack

| Piece | Tool | Cost |
|---|---|---|
| Transcription | Whisper base (multilingual) via transformers.js, in-browser | Free, local |
| MCQ generation | Gemini 2.5 Flash free tier | Free |
| Everything else | Vanilla Chrome MV3 APIs | Free |
