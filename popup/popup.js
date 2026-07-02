// popup.js — start/stop monitoring the active tab. API key lives in config.js.

const toggleBtn = document.getElementById('toggle');
const statusEl = document.getElementById('status');

let sessionActive = false;
let lastError = '';

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'error' : '';
  if (isError) lastError = text;
}

function renderToggle() {
  toggleBtn.textContent = sessionActive ? 'Stop monitoring' : 'Start monitoring this tab';
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    sessionActive = !!(res && res.session && res.session.active);
    const w = (res && res.session && res.session.whisper) || {};
    if (sessionActive) {
      lastError = '';
      setStatus(w.detail || 'Monitoring…');
    } else if (w.status && w.status !== 'idle' && w.status !== 'stopped') {
      // Not active yet, but something is happening (model download, starting up)
      setStatus(w.detail || w.status);
    } else if (lastError) {
      setStatus(lastError, true); // keep errors visible instead of flashing back to Idle
    } else {
      setStatus('Idle');
    }
  } catch (e) {
    sessionActive = false;
    if (!lastError) setStatus('Idle');
  }
  renderToggle();
}

toggleBtn.addEventListener('click', async () => {
  toggleBtn.disabled = true;
  try {
    if (sessionActive) {
      await chrome.runtime.sendMessage({ type: 'STOP_MONITORING' });
      sessionActive = false;
      setStatus('Stopped');
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { setStatus('No active tab', true); toggleBtn.disabled = false; return; }

      setStatus('Starting… (first run downloads the model)');
      const res = await chrome.runtime.sendMessage({ type: 'START_MONITORING', tabId: tab.id });
      if (res && res.ok) {
        sessionActive = true;
        setStatus('Monitoring — quiz every 10 min of playback');
      } else {
        setStatus((res && res.error) || 'Failed to start', true);
      }
    }
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
  renderToggle();
  toggleBtn.disabled = false;
});

refresh();
setInterval(refresh, 2000);
