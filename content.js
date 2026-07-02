// content.js — tracks video playback on any site, triggers a quiz checkpoint
// every 10 minutes of *watched* time. UI helpers come from sidebar.js (same world).

const QUIZ_INTERVAL_SECONDS = 600; // 10 minutes

let lcqMonitoring = false;
let lcqVideo = null;
let lcqWatchedSeconds = 0;
let lcqLastTime = null;
let lcqCheckpointCount = 0;
let lcqAwaitingQuiz = false;
let lcqRescanTimer = null;

function lcqFindMainVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  let best = null;
  let bestArea = 0;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = v; }
  }
  return best;
}

function lcqOnTimeUpdate() {
  if (!lcqMonitoring || lcqAwaitingQuiz || !lcqVideo) return;
  const t = lcqVideo.currentTime;
  if (lcqLastTime !== null) {
    const delta = t - lcqLastTime;
    // Count only normal forward playback; ignore seeks/jumps.
    if (delta > 0 && delta < 2) lcqWatchedSeconds += delta;
  }
  lcqLastTime = t;

  if (lcqWatchedSeconds >= QUIZ_INTERVAL_SECONDS) {
    lcqWatchedSeconds = 0;
    lcqCheckpointCount++;
    lcqTriggerCheckpoint();
  }
}

function lcqTriggerCheckpoint() {
  lcqAwaitingQuiz = true;
  try { lcqVideo.pause(); } catch (e) {}
  lcqShowLoading(lcqCheckpointCount * 10);
  chrome.runtime.sendMessage({ type: 'CHECKPOINT', checkpoint: lcqCheckpointCount }).catch(() => {
    lcqAwaitingQuiz = false;
    lcqShowError('Could not reach the extension background. Try reloading the page.', lcqResume);
  });
}

function lcqResume() {
  lcqAwaitingQuiz = false;
  lcqHideSidebar();
  if (lcqVideo) { try { lcqVideo.play(); } catch (e) {} }
}

function lcqAttach(video) {
  if (lcqVideo === video) return;
  if (lcqVideo) lcqVideo.removeEventListener('timeupdate', lcqOnTimeUpdate);
  lcqVideo = video;
  lcqLastTime = null;
  if (video) video.addEventListener('timeupdate', lcqOnTimeUpdate);
}

function lcqStart() {
  if (lcqMonitoring) return;
  lcqMonitoring = true;
  lcqWatchedSeconds = 0;
  lcqCheckpointCount = 0;
  lcqAttach(lcqFindMainVideo());
  // Handle SPAs (YouTube etc.): periodically re-check that we're on the right <video>.
  lcqRescanTimer = setInterval(() => {
    if (!lcqMonitoring || lcqAwaitingQuiz) return;
    const v = lcqFindMainVideo();
    if (v && v !== lcqVideo) lcqAttach(v);
  }, 3000);
}

function lcqStop() {
  lcqMonitoring = false;
  lcqAwaitingQuiz = false;
  if (lcqRescanTimer) { clearInterval(lcqRescanTimer); lcqRescanTimer = null; }
  lcqAttach(null);
  lcqHideSidebar();
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message && message.type) {
    case 'MONITORING_STARTED':
      lcqStart();
      break;
    case 'MONITORING_STOPPED':
      lcqStop();
      break;
    case 'QUIZ_READY':
      if (lcqAwaitingQuiz) lcqShowQuiz(message.questions, lcqResume);
      break;
    case 'QUIZ_ERROR':
      if (lcqAwaitingQuiz) lcqShowError(message.error, lcqResume);
      break;
  }
});
