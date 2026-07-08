// content.js — tracks video playback on any site. Every EVAL_INTERVAL of watched
// time it asks the background to evaluate the transcript; Gemini decides when
// enough subtopics are complete, and only then does the quiz appear (and the
// video pause). UI helpers come from sidebar.js (same isolated world).

const EVAL_INTERVAL_SECONDS = 120; // how often we ask "is there enough content yet?"

let lcqMonitoring = false;
let lcqVideo = null;
let lcqWatchedSeconds = 0;
let lcqLastTime = null;
let lcqQuizShowing = false;
let lcqRescanTimer = null;
let lcqLastErrorAt = 0;

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
  if (!lcqMonitoring || lcqQuizShowing || !lcqVideo) return;
  const t = lcqVideo.currentTime;
  if (lcqLastTime !== null) {
    const delta = t - lcqLastTime;
    // Count only normal forward playback; ignore seeks/jumps.
    if (delta > 0 && delta < 2) lcqWatchedSeconds += delta;
  }
  lcqLastTime = t;

  if (lcqWatchedSeconds >= EVAL_INTERVAL_SECONDS) {
    lcqWatchedSeconds = 0;
    // Fire-and-forget: video keeps playing while Gemini decides. The outer
    // try/catch covers "extension context invalidated" (extension reloaded
    // while this tab stayed open), which throws synchronously.
    try { chrome.runtime.sendMessage({ type: 'EVALUATE' }).catch(() => {}); } catch (e) {}
  }
}

function lcqShowIncomingQuiz(questions) {
  lcqQuizShowing = true;
  // The sidebar lives in the page body — leave fullscreen or it'd be invisible.
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} }
  try { lcqVideo && lcqVideo.pause(); } catch (e) {}
  lcqShowQuiz(questions, lcqResume);
}

function lcqResume() {
  lcqQuizShowing = false;
  lcqHideSidebar();
  if (lcqVideo) { try { lcqVideo.play(); } catch (e) {} }
}

function lcqOnEnded() {
  // Video finished — quiz whatever content remains, even if under 3 subtopics.
  if (!lcqMonitoring || lcqQuizShowing) return;
  try { chrome.runtime.sendMessage({ type: 'EVALUATE', final: true }).catch(() => {}); } catch (e) {}
}

function lcqAttach(video) {
  if (lcqVideo === video) return;
  if (lcqVideo) {
    lcqVideo.removeEventListener('timeupdate', lcqOnTimeUpdate);
    lcqVideo.removeEventListener('ended', lcqOnEnded);
  }
  lcqVideo = video;
  lcqLastTime = null;
  if (video) {
    video.addEventListener('timeupdate', lcqOnTimeUpdate);
    video.addEventListener('ended', lcqOnEnded);
  }
}

function lcqStart() {
  if (lcqMonitoring) return;
  lcqMonitoring = true;
  lcqWatchedSeconds = 0;
  lcqAttach(lcqFindMainVideo());
  // Handle SPAs (YouTube etc.): periodically re-check that we're on the right <video>.
  lcqRescanTimer = setInterval(() => {
    if (!lcqMonitoring || lcqQuizShowing) return;
    const v = lcqFindMainVideo();
    if (v && v !== lcqVideo) lcqAttach(v);
  }, 3000);
}

function lcqStop() {
  lcqMonitoring = false;
  lcqQuizShowing = false;
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
      // The script runs in every frame; only the frame that owns the video
      // shows the quiz (prevents duplicate sidebars on iframe-based players).
      if (lcqMonitoring && !lcqQuizShowing && lcqVideo) lcqShowIncomingQuiz(message.questions);
      break;
    case 'QUIZ_ERROR':
      // Non-blocking, and throttled: a persistent failure (bad API key, quota)
      // would otherwise pop the error sidebar on every evaluation.
      if (lcqMonitoring && !lcqQuizShowing && lcqVideo && Date.now() - lcqLastErrorAt > 10 * 60 * 1000) {
        lcqLastErrorAt = Date.now();
        lcqShowError(message.error, lcqResume);
      }
      break;
  }
});
