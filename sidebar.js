// sidebar.js — quiz sidebar UI. Loaded before content.js in the same isolated world;
// content.js calls these functions directly (no messaging needed between the two).

const LCQ_SIDEBAR_ID = 'lcq-sidebar';

function lcqEnsureSidebar() {
  let sb = document.getElementById(LCQ_SIDEBAR_ID);
  if (sb) return sb;
  sb = document.createElement('div');
  sb.id = LCQ_SIDEBAR_ID;
  sb.style.cssText = `
    position: fixed; top: 0; right: 0; height: 100vh; width: 340px;
    background: #181818; color: #fff; z-index: 2147483647;
    padding: 20px; box-sizing: border-box; overflow-y: auto;
    box-shadow: -2px 0 12px rgba(0,0,0,0.6); display: none;
    font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.45;
  `;
  document.body.appendChild(sb);
  return sb;
}

function lcqHideSidebar() {
  const sb = document.getElementById(LCQ_SIDEBAR_ID);
  if (sb) sb.style.display = 'none';
}

function lcqShowLoading(checkpointMinutes) {
  const sb = lcqEnsureSidebar();
  sb.style.display = 'block';
  sb.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = `⏸ ${checkpointMinutes}-minute checkpoint`;
  h.style.cssText = 'margin:0 0 12px; font-size:17px;';
  const p = document.createElement('p');
  p.textContent = 'Transcribing the last segment and generating questions…';
  p.style.color = '#bbb';
  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 28px; height: 28px; margin: 18px auto;
    border: 3px solid #444; border-top-color: #4da3ff; border-radius: 50%;
    animation: lcq-spin 0.9s linear infinite;
  `;
  if (!document.getElementById('lcq-style')) {
    const style = document.createElement('style');
    style.id = 'lcq-style';
    style.textContent = '@keyframes lcq-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }
  sb.append(h, p, spinner);
}

function lcqShowError(errorText, onResume) {
  const sb = lcqEnsureSidebar();
  sb.style.display = 'block';
  sb.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = 'Checkpoint skipped';
  h.style.cssText = 'margin:0 0 12px; font-size:17px;';
  const p = document.createElement('p');
  p.textContent = errorText;
  p.style.color = '#ff9c9c';
  sb.append(h, p, lcqButton('Resume video ▶', onResume));
}

function lcqButton(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `
    display:block; width:100%; margin-top:16px; padding:10px;
    background:#4da3ff; color:#0b1a2b; font-weight:600; font-size:14px;
    border:none; border-radius:8px; cursor:pointer;
  `;
  b.addEventListener('click', onClick);
  return b;
}

function lcqShowQuiz(questions, onResume) {
  const sb = lcqEnsureSidebar();
  sb.style.display = 'block';
  sb.innerHTML = '';

  const h = document.createElement('h3');
  h.textContent = '🧠 Quick check — answer to continue';
  h.style.cssText = 'margin:0 0 14px; font-size:17px;';
  sb.appendChild(h);

  let answered = 0;
  let correct = 0;
  const footer = document.createElement('div');

  questions.forEach((q, qi) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:#242424; border-radius:10px; padding:12px; margin-bottom:12px;';

    const qEl = document.createElement('div');
    qEl.textContent = `${qi + 1}. ${q.question}`;
    qEl.style.cssText = 'font-weight:600; margin-bottom:10px;';
    card.appendChild(qEl);

    const buttons = [];
    q.options.forEach((opt, oi) => {
      const btn = document.createElement('button');
      btn.textContent = opt;
      btn.style.cssText = `
        display:block; width:100%; text-align:left; margin-bottom:6px; padding:8px 10px;
        background:#333; color:#eee; border:1px solid #444; border-radius:7px;
        cursor:pointer; font-size:13px;
      `;
      btn.addEventListener('click', () => {
        if (card.dataset.done) return;
        card.dataset.done = '1';
        answered++;
        const isCorrect = oi === q.answerIndex;
        if (isCorrect) correct++;
        buttons.forEach((b, bi) => {
          b.disabled = true;
          b.style.cursor = 'default';
          if (bi === q.answerIndex) { b.style.background = '#1d4a2a'; b.style.borderColor = '#3fae5f'; }
          else if (bi === oi) { b.style.background = '#5a2222'; b.style.borderColor = '#c25353'; }
        });
        if (q.explanation) {
          const ex = document.createElement('div');
          ex.textContent = (isCorrect ? '✅ ' : '❌ ') + q.explanation;
          ex.style.cssText = 'margin-top:8px; color:#bbb; font-size:12.5px;';
          card.appendChild(ex);
        }
        if (answered === questions.length) {
          const score = document.createElement('p');
          score.textContent = `Score: ${correct}/${questions.length}`;
          score.style.cssText = 'font-weight:700; font-size:15px;';
          footer.append(score, lcqButton('Resume video ▶', onResume));
        }
      });
      buttons.push(btn);
      card.appendChild(btn);
    });

    sb.appendChild(card);
  });

  sb.appendChild(footer);
}
