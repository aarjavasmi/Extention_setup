// background.js — orchestrates capture, checkpoints, and Gemini MCQ generation.

// config.js defines LCQ_CONFIG (machine-local, gitignored). If it's missing,
// keep the worker alive — getApiConfig() reports a clear error at quiz time.
try {
  importScripts('config.js');
} catch (e) {
  console.warn('config.js not found. Copy config.example.js to config.js and paste your Gemini API key.');
}

const DEFAULT_MODEL = 'gemini-2.5-flash';

function getApiConfig() {
  const key = (typeof LCQ_CONFIG !== 'undefined' && LCQ_CONFIG.GEMINI_API_KEY) || '';
  const model = (typeof LCQ_CONFIG !== 'undefined' && LCQ_CONFIG.GEMINI_MODEL) || DEFAULT_MODEL;
  if (!key || key === 'PASTE_YOUR_KEY_HERE') {
    throw new Error('Gemini API key missing. Open config.js in the extension folder and paste your key.');
  }
  return { key, model };
}

// Session state survives service-worker restarts via chrome.storage.session
// (MV3 kills the worker after ~30s idle; in-memory state alone gets wiped).
let session = { active: false, tabId: null, whisper: { status: 'idle', detail: '' } };
let sessionLoaded = false;

async function getSession() {
  if (!sessionLoaded) {
    const { lcqSession } = await chrome.storage.session.get('lcqSession');
    if (lcqSession) session = lcqSession;
    sessionLoaded = true;
  }
  return session;
}

function saveSession() {
  chrome.storage.session.set({ lcqSession: session });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio to transcribe the lecture locally with Whisper',
  });
}

// The offscreen page registers its listener asynchronously — retry briefly.
async function sendToOffscreen(message, retries = 10, delayMs = 300) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Content script may not be in the tab yet (e.g. page loaded before the
// extension was reloaded) — inject it on demand, then message it.
async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['sidebar.js', 'content.js'] });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

async function startMonitoring(tabId) {
  await getSession();
  // Already monitoring (this tab or another)? Stop first — otherwise the
  // offscreen page keeps transcribing the OLD tab's audio.
  if (session.active) await stopMonitoring();
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    // A stale capture from a previous session is still holding the tab —
    // tear it down and retry once.
    await stopMonitoring();
    await new Promise((r) => setTimeout(r, 500));
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
  await ensureOffscreenDocument();
  const res = await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_START', streamId });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Offscreen capture failed to start');
  session = { ...session, active: true, tabId };
  saveSession();
  await sendToTab(tabId, { type: 'MONITORING_STARTED' });
}

async function stopMonitoring() {
  await getSession();
  // Stop the capture but keep the offscreen document alive — the Whisper model
  // stays warm in memory, so restarting monitoring is instant instead of a
  // 10-30s model re-initialization.
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' }); } catch (e) {}
  if (session.tabId != null) {
    try { await chrome.tabs.sendMessage(session.tabId, { type: 'MONITORING_STOPPED' }); } catch (e) {}
  }
  session = { active: false, tabId: null, whisper: { status: 'idle', detail: '' } };
  saveSession();
}

// Adaptive checkpoints: Gemini looks at the transcript accumulated since the
// last quiz and decides whether at least one subtopic is complete. If yes, it
// returns one MCQ per completed subtopic and the transcript window resets.
let evaluating = false;

async function handleEvaluate(tabId, isFinal = false) {
  if (evaluating) return; // an evaluation is already in flight
  evaluating = true;
  try {
    const { key, model } = getApiConfig();

    // Peek at the transcript without consuming it.
    const res = await sendToOffscreen({ target: 'offscreen', type: 'GET_TRANSCRIPT', consume: false });
    if (!res || !res.ok) return;

    const transcript = (res.text || '').trim();
    // Normally 3+ subtopics need real substance; at video end, quiz whatever remains.
    if (transcript.split(/\s+/).length < (isFinal ? 60 : 300)) return;

    const result = await evaluateAndGenerate(transcript, key, model, isFinal);
    const minQuestions = isFinal ? 1 : 3;
    if (result.ready && Array.isArray(result.questions) && result.questions.length >= minQuestions) {
      // Consume only what we quizzed on; speech that arrived meanwhile is kept.
      await sendToOffscreen({ target: 'offscreen', type: 'CONSUME_TRANSCRIPT', count: res.count });
      await chrome.tabs.sendMessage(tabId, { type: 'QUIZ_READY', questions: result.questions.slice(0, 4) });
    }
    // Not ready → do nothing; the next evaluation fires automatically.
  } catch (e) {
    // Surface real failures (bad API key, quota) without pausing the lecture.
    try { await chrome.tabs.sendMessage(tabId, { type: 'QUIZ_ERROR', error: String(e.message || e) }); } catch (_) {}
  } finally {
    evaluating = false;
  }
}

async function evaluateAndGenerate(transcript, apiKey, model, isFinal = false) {
  const finalNote = isFinal
    ? 'NOTE: The video has ENDED — this is the last chance to quiz. If there is ANY testable content at all, respond ready=true with one question per covered subtopic (1-4 questions), even if only one subtopic is complete. '
    : '';
  const prompt =
    'You are a tutor monitoring a live video lecture to promote active recall. ' + finalNote +
    'Below is the (imperfect, auto-generated) transcript accumulated since the last quiz. ' +
    'First decide: has the lecturer COMPLETED at least THREE distinct, coherent subtopics with enough substance to test? ' +
    'A subtopic is complete when its explanation has clearly concluded — not mid-explanation. ' +
    'If fewer than 3 subtopics are complete, or the content is too thin, respond with ready=false and an empty questions array — the student keeps watching. ' +
    'If 3 or more subtopics are complete, respond with ready=true and EXACTLY ONE multiple-choice question per completed subtopic (3-4 questions; if more than 4 subtopics completed, pick the 4 most important). ' +
    'Rules per question: name the subtopic; 4 options, exactly one correct; plausible distractors; ' +
    'do not reference "the transcript"; ignore transcription glitches; keep questions self-contained. ' +
    'The lecture may be in English, Hindi, or Hinglish, but ALWAYS write subtopics, questions, options, and explanations in English only. ' +
    'Standard technical terms used by the lecturer stay as-is.\n\nTRANSCRIPT:\n' + transcript;
    
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          ready: { type: 'BOOLEAN', description: 'true only if at least one subtopic is fully covered' },
          questions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                subtopic: { type: 'STRING' },
                question: { type: 'STRING' },
                options: { type: 'ARRAY', items: { type: 'STRING' } },
                answerIndex: { type: 'INTEGER', description: '0-based index of the correct option' },
                explanation: { type: 'STRING' },
              },
              required: ['subtopic', 'question', 'options', 'answerIndex'],
            },
          },
        },
        required: ['ready', 'questions'],
      },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response');

  const result = JSON.parse(text);
  return {
    ready: !!result.ready,
    questions: (result.questions || []).filter(
      (q) => q.question && Array.isArray(q.options) && q.options.length >= 2
    ),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return; // offscreen handles its own

  switch (message.type) {
    case 'START_MONITORING':
      startMonitoring(message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;

    case 'STOP_MONITORING':
      stopMonitoring().then(() => sendResponse({ ok: true }));
      return true;

    case 'GET_STATUS':
      getSession().then((s) => sendResponse({ ok: true, session: s }));
      return true;

    case 'WHISPER_STATUS':
      getSession().then(() => {
        session.whisper = { status: message.status, detail: message.detail || '' };
        saveSession();
      });
      return false;

    case 'EVALUATE': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) handleEvaluate(tabId, !!message.final);
      sendResponse({ ok: true });
      return false;
    }
  }
});

// If the monitored tab is closed, stop the capture instead of transcribing
// a dead tab forever.
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  await getSession();
  if (session.active && session.tabId === closedTabId) stopMonitoring();
});
