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
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'OFFSCREEN_STOP' }); } catch (e) {}
  try { await chrome.offscreen.closeDocument(); } catch (e) {}
  if (session.tabId != null) {
    try { await chrome.tabs.sendMessage(session.tabId, { type: 'MONITORING_STOPPED' }); } catch (e) {}
  }
  session = { active: false, tabId: null, whisper: { status: 'idle', detail: '' } };
  saveSession();
}

async function handleCheckpoint(tabId) {
  try {
    const { key, model } = getApiConfig();

    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_TRANSCRIPT' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not get transcript');

    const transcript = (res.text || '').trim();
    if (transcript.split(/\s+/).length < 30) {
      throw new Error('Not enough transcribed speech in this segment to generate questions.');
    }

    const questions = await generateMCQs(transcript, key, model);
    await chrome.tabs.sendMessage(tabId, { type: 'QUIZ_READY', questions });
  } catch (e) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'QUIZ_ERROR', error: String(e.message || e) }); } catch (_) {}
  }
}

async function generateMCQs(transcript, apiKey, model) {
  const prompt =
    'You are a tutor helping a student stay attentive during a video lecture. ' +
    'Below is the (imperfect, auto-generated) transcript of the last ~10 minutes of the lecture. ' +
    'Write exactly 3 multiple-choice questions that test understanding of the KEY concepts actually explained in this segment. ' +
    'Rules: 4 options each, exactly one correct; plausible distractors; do not reference "the transcript"; ' +
    'ignore transcription glitches; keep questions self-contained. ' +
    'The lecture may be in English, Hindi, or Hinglish, but ALWAYS write the questions, options, and explanations in English only. ' +
    'Standard technical terms used by the lecturer stay as-is.\n\nTRANSCRIPT:\n' + transcript;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            question: { type: 'STRING' },
            options: { type: 'ARRAY', items: { type: 'STRING' } },
            answerIndex: { type: 'INTEGER', description: '0-based index of the correct option' },
            explanation: { type: 'STRING' },
          },
          required: ['question', 'options', 'answerIndex'],
        },
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

  const questions = JSON.parse(text);
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('Gemini returned no questions');
  return questions
    .filter((q) => q.question && Array.isArray(q.options) && q.options.length >= 2)
    .slice(0, 3);
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

    case 'CHECKPOINT': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) handleCheckpoint(tabId);
      sendResponse({ ok: true });
      return false;
    }
  }
});
