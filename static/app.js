/* Literacy Trainer — client.
 *
 * Two clean modes:
 *   - server: REST + WebSocket, no API key in browser, multi-user
 *   - webllm: in-browser model only, no server interaction (preserved from v0)
 */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  mode: 'server',                           // 'server' | 'webllm'
  sessionId: null,
  learnerName: '',
  participants: [],
  // Local mirror of the server transcript (or, in webllm mode, the only copy).
  // Each entry: {id, speaker, learner_name?, recipient?, text, score?, justification?, ts}
  transcript: [],
  scores: [],                                // {questionId, question, score, justification}
  done: false,
  busy: false,
  ws: null,
  // ----- server-mode config -----
  paperTitle: '',
  paperText: '',
  learnerLevel: 'undergraduate',
  professorModel: 'claude-sonnet-4-6',
  partnerModel: 'claude-sonnet-4-6',
  allowedModels: [],
  // ----- webllm-mode config -----
  webllmModelId: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  webllmEngine: null,
  webllmReady: false,
};

const LS = {
  NAME: 'lit-trainer.learnerName',
  LEVEL: 'lit-trainer.learnerLevel',
  PROF_MODEL: 'lit-trainer.professorModel',
  PART_MODEL: 'lit-trainer.partnerModel',
  MODEL_LEGACY: 'lit-trainer.model',         // pre-v1.1 single key — read once, then ignore
  WEBLLM: 'lit-trainer.webllmModel',
  MODE: 'lit-trainer.mode',
};

/* =================================================================== */
/* === Bootstrap ==================================================== */
/* =================================================================== */

(async function init() {
  restoreSettings();
  bindUI();
  await loadServerConfig();
  applyModeUI();
  // If the URL has ?s=CODE, prefill the join flow.
  const params = new URLSearchParams(location.search);
  const incoming = params.get('s');
  if (incoming) {
    $('#mode').value = 'join';
    state.mode = 'server';
    $('#joinCode').value = incoming.toUpperCase();
    applyModeUI();
  }
  checkWebGPU();
})();

function restoreSettings() {
  try {
    const n = localStorage.getItem(LS.NAME);     if (n) $('#learnerName').value = n;
    const l = localStorage.getItem(LS.LEVEL);    if (l) $('#learnerLevel').value = l;
    const legacy = localStorage.getItem(LS.MODEL_LEGACY);
    const pm = localStorage.getItem(LS.PROF_MODEL) || legacy;
    const tm = localStorage.getItem(LS.PART_MODEL) || legacy;
    if (pm) state.professorModel = pm;
    if (tm) state.partnerModel = tm;
    const w = localStorage.getItem(LS.WEBLLM);
    if (w) { $('#webllmModel').value = w; state.webllmModelId = w; }
    const md = localStorage.getItem(LS.MODE);
    if (md) $('#mode').value = md;
  } catch (e) {}
}

async function loadServerConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return;
    const cfg = await r.json();
    state.allowedModels = cfg.allowed_models || [];
    const fallback = cfg.default_model || state.allowedModels[0] || '';
    const populate = (selId, current) => {
      const sel = $(selId);
      if (!sel) return current;
      sel.innerHTML = '';
      for (const m of state.allowedModels) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = labelForModel(m);
        sel.appendChild(opt);
      }
      sel.value = (current && state.allowedModels.includes(current)) ? current : fallback;
      return sel.value;
    };
    state.professorModel = populate('#professorModel', state.professorModel);
    state.partnerModel   = populate('#partnerModel',   state.partnerModel);
  } catch (e) {
    // Server config unavailable — server mode will fail loudly later.
  }
}

function labelForModel(m) {
  const map = {
    'claude-opus-4-7':  'Claude Opus 4.7 (deepest reasoning, slowest)',
    'claude-opus-4-6':  'Claude Opus 4.6',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (recommended)',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5 (fastest / cheapest)',
  };
  return map[m] || m;
}

/* =================================================================== */
/* === UI wiring ==================================================== */
/* =================================================================== */

function bindUI() {
  $('#mode').addEventListener('change', () => {
    try { localStorage.setItem(LS.MODE, $('#mode').value); } catch (e) {}
    applyModeUI();
  });
  $('#learnerName').addEventListener('change', () => {
    try { localStorage.setItem(LS.NAME, $('#learnerName').value.trim()); } catch (e) {}
  });
  $('#learnerLevel').addEventListener('change', () => {
    try { localStorage.setItem(LS.LEVEL, $('#learnerLevel').value); } catch (e) {}
  });
  $('#professorModel').addEventListener('change', () => {
    state.professorModel = $('#professorModel').value;
    try { localStorage.setItem(LS.PROF_MODEL, state.professorModel); } catch (e) {}
  });
  $('#partnerModel').addEventListener('change', () => {
    state.partnerModel = $('#partnerModel').value;
    try { localStorage.setItem(LS.PART_MODEL, state.partnerModel); } catch (e) {}
  });
  $('#webllmModel').addEventListener('change', () => {
    state.webllmModelId = $('#webllmModel').value;
    state.webllmEngine = null;
    state.webllmReady = false;
    $('#webllmStatus').textContent = 'Model changed — will load on next use.';
    try { localStorage.setItem(LS.WEBLLM, state.webllmModelId); } catch (e) {}
  });
  $('#btnPreloadWebLLM').addEventListener('click', async () => {
    $('#btnPreloadWebLLM').disabled = true;
    try { await ensureWebLLM(); }
    catch (e) { $('#webllmStatus').textContent = 'Failed: ' + e.message; }
    finally { $('#btnPreloadWebLLM').disabled = false; }
  });

  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    $$('.tab-panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelector(`.tab-panel[data-tab="${t.dataset.tab}"]`).classList.add('active');
    if (t.dataset.tab === 'library') loadArticleLibrary();
  }));

  $('#pdfFile').addEventListener('change', onPdfUpload);
  $('#urlFetchBtn').addEventListener('click', onUrlFetch);
  $('#btnRefreshSessions').addEventListener('click', loadSessionBrowser);
  $('#showEnded').addEventListener('change', loadSessionBrowser);
  $('#btnRefreshArticles').addEventListener('click', loadArticleLibrary);
  $('#btnStart').addEventListener('click', onStart);
  $('#btnEnd').addEventListener('click', onEnd);
  $('#btnSettings').addEventListener('click', onSettings);

  $('#btnSend').addEventListener('click', onSend);
  $('#learnerInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#btnSend').click(); }
  });

  $('#btnTranscript').addEventListener('click', () => {
    $('#transcriptContent').textContent = renderTranscriptText();
    $('#transcriptModal').classList.remove('hidden');
  });
  $('#btnCloseTranscript').addEventListener('click', () => $('#transcriptModal').classList.add('hidden'));
  $('#btnCopyTranscript').addEventListener('click', async () => {
    await navigator.clipboard.writeText(renderTranscriptText());
    $('#btnCopyTranscript').textContent = 'Copied!';
    setTimeout(() => $('#btnCopyTranscript').textContent = 'Copy to clipboard', 1200);
  });
  $('#btnExportMd').addEventListener('click', exportMarkdown);
  $('#btnExportJson').addEventListener('click', exportJson);
  $('#btnReportExportMd').addEventListener('click', exportMarkdown);
  $('#btnReportClose').addEventListener('click', () => $('#reportModal').classList.add('hidden'));

  $('#btnCopyCode').addEventListener('click', async () => {
    if (!state.sessionId) return;
    const url = `${location.origin}/?s=${state.sessionId}`;
    await navigator.clipboard.writeText(url);
    $('#btnCopyCode').textContent = 'copied';
    setTimeout(() => $('#btnCopyCode').textContent = 'copy', 1200);
  });
}

function applyModeUI() {
  const mode = $('#mode').value;
  // Server-config card is needed for server mode (creator) and webllm; hidden for joiners.
  $('#joinFields').classList.toggle('hidden', mode !== 'join');
  $('#serverConfigCard').classList.toggle('hidden', mode === 'join');
  $('#webllmConfigCard').classList.toggle('hidden', mode !== 'webllm');
  $('#btnStart').textContent = mode === 'join' ? 'Join session' : 'Begin session';
  if (mode === 'join') loadSessionBrowser();
}

function loadSessionBrowser() {
  const browser = $('#sessionBrowser');
  const countEl = $('#sessionBrowserCount');
  if (!browser) return;
  browser.innerHTML = '<div class="session-browser-empty">Loading…</div>';
  countEl.textContent = '';
  fetch('/api/sessions')
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(rows => {
      const showEnded = $('#showEnded').checked;
      const filtered = showEnded ? rows : rows.filter(r => !r.ended_at);
      const endedCount = rows.length - rows.filter(r => !r.ended_at).length;
      countEl.textContent = showEnded
        ? `(${rows.length})`
        : (endedCount > 0 ? `(${filtered.length} active · ${endedCount} ended hidden)` : `(${filtered.length})`);
      if (filtered.length === 0) {
        browser.innerHTML = '<div class="session-browser-empty">' +
          (rows.length === 0
            ? 'No sessions yet — ask the host to create one, or paste a code below.'
            : 'No active sessions. Tick "show ended" to see closed ones.') +
          '</div>';
        return;
      }
      browser.innerHTML = '';
      const currentCode = ($('#joinCode').value || '').trim().toUpperCase();
      filtered.forEach(s => {
        const row = document.createElement('div');
        row.className = 'session-row' + (s.id === currentCode ? ' selected' : '');
        const title = String(s.paper_title || 'Untitled')
          .replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
        const ageMs = Date.now() - (s.created_at || 0);
        const partN = s.participant_count || 0;
        const msgN = s.message_count || 0;
        const ended = s.ended_at ? '<span class="ended-pill">ended</span>' : '';
        row.innerHTML =
          `<div class="title">${title}</div>` +
          `<div class="code">${s.id}</div>` +
          `<div class="meta">` +
            `<span>${humanizeAge(ageMs)}</span>` +
            `<span>${partN} ${partN === 1 ? 'participant' : 'participants'}</span>` +
            `<span>${msgN} ${msgN === 1 ? 'msg' : 'msgs'}</span>` +
            `<span>${labelForModel(s.model)}</span>` +
            ended +
          `</div>`;
        row.addEventListener('click', () => {
          $('#joinCode').value = s.id;
          $$('#sessionBrowser .session-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          $('#startStatus').textContent = '';
        });
        browser.appendChild(row);
      });
    })
    .catch(e => {
      browser.innerHTML = `<div class="session-browser-empty">Couldn't load: ${e.message}</div>`;
    });
}

function loadArticleLibrary() {
  const lib = $('#articleLibrary');
  const countEl = $('#articleLibCount');
  if (!lib) return;
  lib.innerHTML = '<div class="session-browser-empty">Loading…</div>';
  countEl.textContent = '';
  $('#articleLibStatus').textContent = '';
  fetch('/api/articles')
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(rows => {
      countEl.textContent = `(${rows.length})`;
      if (rows.length === 0) {
        lib.innerHTML = '<div class="session-browser-empty">No articles yet — paste, upload, or fetch one in the other tabs and it’ll appear here next time.</div>';
        return;
      }
      lib.innerHTML = '';
      rows.forEach(a => {
        const row = document.createElement('div');
        row.className = 'session-row';
        const title = String(a.paper_title || 'Untitled')
          .replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
        const ageMs = Date.now() - (a.last_used_at || 0);
        const chars = (a.char_count || 0).toLocaleString();
        const sN = a.session_count || 1;
        row.innerHTML =
          `<div class="title">${title}</div>` +
          `<div class="code">${chars} chars</div>` +
          `<div class="meta">` +
            `<span>last used ${humanizeAge(ageMs)}</span>` +
            `<span>${sN} ${sN === 1 ? 'session' : 'sessions'}</span>` +
          `</div>`;
        row.addEventListener('click', () => pickArticleFromLibrary(a, row));
        lib.appendChild(row);
      });
    })
    .catch(e => {
      lib.innerHTML = `<div class="session-browser-empty">Couldn't load: ${e.message}</div>`;
    });
}

async function pickArticleFromLibrary(a, row) {
  $('#articleLibStatus').textContent = 'Loading article…';
  try {
    const r = await fetch(`/api/articles/by-session/${encodeURIComponent(a.latest_session_id)}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    state.paperText = data.paper_text || '';
    state.paperTitle = data.paper_title || a.paper_title || 'Untitled';
    $('#pasteTitle').value = state.paperTitle;
    $('#pasteText').value = state.paperText;
    $$('#articleLibrary .session-row').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    // Switch to the Paste tab so the user can see/edit before starting.
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'paste'));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === 'paste'));
    $('#articleLibStatus').textContent = `Loaded "${state.paperTitle}" (${state.paperText.length.toLocaleString()} chars). Edit if needed, then Begin.`;
  } catch (e) {
    $('#articleLibStatus').textContent = 'Failed to load: ' + e.message;
  }
}

function humanizeAge(ms) {
  if (!ms || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function checkWebGPU() {
  if (!navigator.gpu) {
    $('#gpuWarning').classList.remove('hidden');
    $('#gpuWarning').innerHTML = '⚠️ This browser doesn\'t expose WebGPU. Solo offline mode requires Chrome/Edge 113+ or Safari 18+. Group mode (server-backed) works in any modern browser.';
  }
}

/* =================================================================== */
/* === Article input ================================================ */
/* =================================================================== */

async function onPdfUpload(e) {
  const f = e.target.files[0];
  if (!f) return;
  $('#pdfStatus').textContent = 'Uploading & parsing on server…';
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch('/api/extract-pdf', { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    const data = await r.json();
    state.paperText = data.text || '';
    state.paperTitle = (data.filename || '').replace(/\.pdf$/i, '') || state.paperTitle;
    $('#pdfStatus').innerHTML = `Extracted <b>${data.char_count.toLocaleString()}</b> characters from <b>${data.num_pages}</b> page(s).`;
  } catch (err) {
    $('#pdfStatus').textContent = 'Failed: ' + err.message;
  }
}

async function onUrlFetch() {
  const url = $('#urlInput').value.trim();
  if (!url) return;
  $('#urlStatus').textContent = 'Fetching…';
  try {
    let html = '';
    try {
      const direct = await fetch(url);
      if (!direct.ok) throw new Error('HTTP ' + direct.status);
      html = await direct.text();
    } catch (e) {
      const proxied = await fetch('https://r.jina.ai/' + url);
      if (!proxied.ok) throw new Error('Proxy HTTP ' + proxied.status);
      html = await proxied.text();
    }
    let text = html;
    if (/<\/?[a-z][\s\S]*>/i.test(html)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const t = tmp.querySelector('title');
      if (t) state.paperTitle = t.textContent.trim();
      tmp.querySelectorAll('script,style,noscript').forEach(n => n.remove());
      text = tmp.textContent.replace(/\n{3,}/g, '\n\n').trim();
    }
    state.paperText = text;
    if (!state.paperTitle) state.paperTitle = url;
    $('#urlStatus').innerHTML = `Fetched <b>${text.length.toLocaleString()}</b> characters.`;
  } catch (err) {
    $('#urlStatus').textContent = 'Could not fetch: ' + err.message;
  }
}

/* =================================================================== */
/* === Start / Join ================================================= */
/* =================================================================== */

async function onStart() {
  $('#startStatus').textContent = '';
  const mode = $('#mode').value;
  state.learnerName = $('#learnerName').value.trim() || 'Learner';
  state.learnerLevel = $('#learnerLevel').value;

  if (mode === 'webllm') {
    state.mode = 'webllm';
    return startWebllmSession();
  }

  if (mode === 'join') {
    state.mode = 'server';
    return joinServerSession();
  }

  state.mode = 'server';
  return startServerSession();
}

async function startServerSession() {
  const pasted = $('#pasteText').value.trim();
  if (pasted) {
    state.paperText = pasted;
    state.paperTitle = $('#pasteTitle').value.trim() || state.paperTitle || 'Untitled article';
  }
  if (!state.paperText || state.paperText.length < 200) {
    $('#startStatus').textContent = 'Need at least ~200 characters of article text (paste, PDF, or URL fetch).';
    return;
  }
  $('#startStatus').textContent = 'Creating session…';
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paper_title: state.paperTitle || 'Untitled article',
        paper_text: state.paperText,
        learner_level: state.learnerLevel,
        professor_model: state.professorModel,
        partner_model: state.partnerModel,
        learner_name: state.learnerName,
      }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    const data = await r.json();
    state.sessionId = data.session_id;
    state.paperTitle = data.paper_title;
    enterSessionScreen({ professor_model: data.professor_model, partner_model: data.partner_model });
  } catch (e) {
    $('#startStatus').textContent = 'Failed to create session: ' + e.message;
  }
}

async function joinServerSession() {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!code) { $('#startStatus').textContent = 'Enter a session code.'; return; }
  $('#startStatus').textContent = 'Joining…';
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ learner_name: state.learnerName }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    const meta = await fetchSessionMeta(code);
    state.sessionId = code;
    state.paperTitle = meta.paper_title;
    enterSessionScreen(meta);
  } catch (e) {
    $('#startStatus').textContent = 'Failed to join: ' + e.message;
  }
}

async function fetchSessionMeta(code) {
  const r = await fetch(`/api/sessions/${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error('Session not found');
  return r.json();
}

function enterSessionScreen(meta) {
  $('#setupScreen').classList.add('hidden');
  $('#sessionScreen').classList.remove('hidden');
  $('#btnTranscript').classList.remove('hidden');
  $('#btnEnd').classList.remove('hidden');
  $('#paperTitle').textContent = state.paperTitle || '';
  $('#sessionCodeBadge').classList.remove('hidden');
  $('#sessionCodeBadge').textContent = state.sessionId;
  $('#sessionCodeInline').textContent = state.sessionId;
  $('#sessionModeLabel').textContent = 'Group';
  $('#wsStatus').classList.remove('hidden');

  // Both agent badges are <select>s — populated once with allowedModels, value
  // set per-session, change handler hits the live-update endpoint.
  const profM = meta?.professor_model || meta?.model || '';
  const partM = meta?.partner_model   || meta?.model || '';
  populateLiveModelSelect('#professorModelBadge', profM, 'professor_model');
  populateLiveModelSelect('#partnerModelBadge',   partM, 'partner_model');

  // Replay any messages already on the server (joiners arriving mid-session).
  if (meta && Array.isArray(meta.messages)) {
    for (const m of meta.messages) ingestMessage(m);
    state.participants = meta.participants || [];
    renderParticipants();
  }
  connectWebSocket();
  history.replaceState(null, '', `${location.pathname}?s=${state.sessionId}`);
}

function populateLiveModelSelect(selector, currentValue, payloadKey) {
  const sel = $(selector);
  if (!sel) return;
  sel.innerHTML = '';
  const opts = state.allowedModels.length ? state.allowedModels : (currentValue ? [currentValue] : []);
  for (const m of opts) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = labelForModel(m);
    sel.appendChild(opt);
  }
  if (currentValue && !opts.includes(currentValue)) {
    // Solo (webllm) mode — model isn't in allowedModels; show it anyway, disabled.
    const opt = document.createElement('option');
    opt.value = currentValue;
    opt.textContent = currentValue;
    sel.appendChild(opt);
  }
  sel.value = currentValue || (opts[0] || '');
  sel.disabled = state.mode !== 'server';   // can't hot-swap a WebLLM engine
  sel.onchange = () => onLiveModelChange(payloadKey, sel.value);
}

async function onLiveModelChange(payloadKey, value) {
  if (state.mode !== 'server' || !state.sessionId) return;
  $('#composerStatus').textContent = `Switching ${payloadKey === 'professor_model' ? 'Professor' : 'Study Partner'} to ${labelForModel(value)}…`;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [payloadKey]: value }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    // The server broadcasts a models_changed event back; that handler clears the status.
  } catch (e) {
    $('#composerStatus').textContent = 'Could not switch model: ' + e.message;
  }
}

async function startWebllmSession() {
  const pasted = $('#pasteText').value.trim();
  if (pasted) {
    state.paperText = pasted;
    state.paperTitle = $('#pasteTitle').value.trim() || state.paperTitle || 'Untitled article';
  }
  if (!state.paperText || state.paperText.length < 200) {
    $('#startStatus').textContent = 'Need at least ~200 characters of article text.';
    return;
  }
  if (!navigator.gpu) {
    $('#startStatus').textContent = 'Solo offline needs WebGPU (Chrome/Edge 113+ or Safari 18+).';
    return;
  }
  $('#startStatus').textContent = 'Loading local model — first run downloads ~2 GB, then cached…';
  try { await ensureWebLLM(); }
  catch (e) { $('#startStatus').textContent = 'Failed to load model: ' + e.message; return; }

  $('#setupScreen').classList.add('hidden');
  $('#sessionScreen').classList.remove('hidden');
  $('#btnTranscript').classList.remove('hidden');
  $('#btnEnd').classList.remove('hidden');
  $('#paperTitle').textContent = state.paperTitle;
  $('#sessionCodeBadge').classList.add('hidden');
  $('#sessionModeLabel').textContent = 'Solo (offline)';
  $('#sessionCodeInline').textContent = '–';
  $('#wsStatus').classList.add('hidden');
  populateLiveModelSelect('#professorModelBadge', state.webllmModelId || '', 'professor_model');
  populateLiveModelSelect('#partnerModelBadge',   state.webllmModelId || '', 'partner_model');

  setBusy(true);
  $('#composerStatus').textContent = 'The Professor is preparing the first question…';
  try { await callProfessorWebllm(true); }
  catch (e) { addNote('professor', 'Error: ' + e.message); }
  finally { setBusy(false); $('#composerStatus').textContent = ''; }
}

/* =================================================================== */
/* === WebSocket (server mode) ====================================== */
/* =================================================================== */

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/sessions/${encodeURIComponent(state.sessionId)}`);
  state.ws = ws;
  ws.onopen = () => setWsStatus(true);
  ws.onclose = () => { setWsStatus(false); state.ws = null; };
  ws.onerror = () => setWsStatus(false);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsEvent(msg);
  };
}

function setWsStatus(connected) {
  const el = $('#wsStatus');
  el.classList.toggle('connected', connected);
  el.querySelector('.ws-label').textContent = connected ? 'connected' : 'disconnected';
}

function handleWsEvent(ev) {
  if (ev.type === 'message') {
    ingestMessage(ev.message);
  } else if (ev.type === 'score') {
    applyScore(ev.message_id, ev.score, ev.justification);
  } else if (ev.type === 'participant_joined') {
    if (!state.participants.includes(ev.learner_name)) state.participants.push(ev.learner_name);
    renderParticipants();
  } else if (ev.type === 'models_changed') {
    const profSel = $('#professorModelBadge');
    const partSel = $('#partnerModelBadge');
    if (ev.professor_model && profSel) profSel.value = ev.professor_model;
    if (ev.partner_model   && partSel) partSel.value = ev.partner_model;
    addNote('professor', `Model swap — Professor: ${labelForModel(ev.professor_model)} · Study Partner: ${labelForModel(ev.partner_model)}`);
    $('#composerStatus').textContent = '';
  } else if (ev.type === 'session_ended') {
    state.done = true;
    showFinalReport({
      final_score: ev.final_score,
      final_summary: ev.final_summary,
    });
    $('#btnSend').disabled = true;
    $('#btnEnd').disabled = true;
    $('#composerStatus').textContent = 'Session ended.';
  } else if (ev.type === 'error') {
    addNote(ev.agent || 'professor', 'Server error: ' + ev.error);
  }
}

/* =================================================================== */
/* === Compose & send (server mode) ================================= */
/* =================================================================== */

async function onSend() {
  if (state.busy || state.done) return;
  const text = $('#learnerInput').value.trim();
  if (!text) return;
  const recipient = $('#addressee').value;
  $('#learnerInput').value = '';

  if (state.mode === 'webllm') {
    addMessageLocal({ speaker: 'learner', recipient, text, learner_name: state.learnerName });
    setBusy(true);
    try {
      if (recipient === 'professor') await callProfessorWebllm(false);
      else await callPartnerWebllm();
    } catch (e) {
      addNote(recipient, 'Error: ' + e.message);
    } finally { setBusy(false); }
    return;
  }

  setBusy(true);
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        learner_name: state.learnerName,
        recipient,
        text,
      }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    // Echoes back via WS — no local render here.
  } catch (e) {
    addNote(recipient, 'Failed to send: ' + e.message);
  } finally { setBusy(false); }
}

async function onEnd() {
  if (state.busy || state.done) return;
  if (!confirm('End the session now and ask the Professor for a final assessment?')) return;
  if (state.mode === 'webllm') {
    setBusy(true);
    $('#composerStatus').textContent = 'Asking the Professor to wrap up…';
    try { await callProfessorWebllm(false, true); }
    catch (e) { addNote('professor', 'Error: ' + e.message); }
    finally { setBusy(false); $('#composerStatus').textContent = ''; }
    return;
  }
  setBusy(true);
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/end`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  } catch (e) {
    addNote('professor', 'Failed to end session: ' + e.message);
  } finally { setBusy(false); }
}

function onSettings() {
  if ($('#sessionScreen').classList.contains('hidden')) { $('#learnerName').focus(); return; }
  if (!confirm('Return to setup? Your local view will be cleared but the server transcript remains.')) return;
  resetToSetup();
}

function resetToSetup() {
  if (state.ws) try { state.ws.close(); } catch (e) {}
  state.ws = null;
  state.transcript = [];
  state.scores = [];
  state.done = false;
  state.sessionId = null;
  state.participants = [];
  $('#professorMessages').innerHTML = '';
  $('#partnerMessages').innerHTML = '';
  $('#sessionScreen').classList.add('hidden');
  $('#setupScreen').classList.remove('hidden');
  $('#btnTranscript').classList.add('hidden');
  $('#btnEnd').classList.add('hidden');
  $('#sessionCodeBadge').classList.add('hidden');
  $('#wsStatus').classList.add('hidden');
  $('#paperTitle').textContent = '';
  history.replaceState(null, '', location.pathname);
}

/* =================================================================== */
/* === Rendering ==================================================== */
/* =================================================================== */

function paneFor(speaker, recipient) {
  if (speaker === 'partner') return $('#partnerMessages');
  if (speaker === 'professor') return $('#professorMessages');
  // learner: route by recipient
  return recipient === 'partner' ? $('#partnerMessages') : $('#professorMessages');
}

function ingestMessage(m) {
  // De-dupe: if we already have this id in the transcript, skip.
  if (m.id != null && state.transcript.some(t => t.id === m.id)) return;
  state.transcript.push(m);
  const node = renderMessageNode(m);
  paneFor(m.speaker, m.recipient).appendChild(node);
  scrollPaneToBottom(paneFor(m.speaker, m.recipient));
  if (m.speaker === 'professor') {
    // Try to record this as the question for the next score row in the scoreboard.
    const lastQ = state.transcript.filter(t => t.speaker === 'professor').slice(-1)[0];
    state._pendingProfessorQuestion = lastQ ? lastQ.text.slice(0, 200) : '';
  }
}

function applyScore(messageId, score, justification) {
  const m = state.transcript.find(t => t.id === messageId);
  if (m) { m.score = score; m.justification = justification; }
  // Re-render: easiest approach is to add a score badge to the existing learner msg DOM.
  // Each rendered learner msg has data-msg-id; find and append.
  const node = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (node && !node.querySelector('.score-line')) {
    const s = document.createElement('div');
    s.className = 'score-line';
    s.innerHTML = `Score: <strong>${score}/10</strong>` +
      (justification ? ` · <span style="color:var(--muted)">${escapeHtml(justification)}</span>` : '');
    node.appendChild(s);
  }
  // Track for scoreboard
  state.scores.push({
    questionId: messageId,
    question: state._pendingProfessorQuestion || '',
    score,
    justification: justification || '',
  });
}

function addMessageLocal(m) {
  // For webllm mode where there's no server. Synthesize an id.
  const entry = { id: Date.now() + Math.random(), ...m, ts: Date.now() };
  ingestMessage(entry);
  return entry;
}

function renderMessageNode(m) {
  const div = document.createElement('div');
  const isMine = m.speaker === 'learner' && m.learner_name === state.learnerName;
  const otherLearner = m.speaker === 'learner' && !isMine;
  div.className = 'msg from-' + m.speaker + (otherLearner ? ' someone-else' : '');
  if (m.id != null) div.dataset.msgId = m.id;
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (m.speaker === 'learner') {
    const who = m.learner_name || 'Learner';
    meta.textContent = `${isMine ? 'You' : who} → ${m.recipient === 'partner' ? 'Study Partner' : 'Professor'}`;
  } else {
    meta.textContent = m.speaker === 'professor' ? 'The Professor' : 'The Study Partner';
  }
  div.appendChild(meta);
  const body = document.createElement('div');
  body.textContent = m.text;
  div.appendChild(body);

  if (typeof m.score === 'number') {
    const s = document.createElement('div');
    s.className = 'score-line';
    s.innerHTML = `Score: <strong>${m.score}/10</strong>` +
      (m.justification ? ` · <span style="color:var(--muted)">${escapeHtml(m.justification)}</span>` : '');
    div.appendChild(s);
  }
  return div;
}

function addNote(side, text) {
  const pane = paneFor(side);
  const div = document.createElement('div');
  div.className = 'msg note';
  div.textContent = text;
  pane.appendChild(div);
  scrollPaneToBottom(pane);
}

function scrollPaneToBottom(pane) { pane.scrollTop = pane.scrollHeight; }

function renderParticipants() {
  const bar = $('#participantsBar');
  bar.innerHTML = '';
  for (const name of state.participants) {
    const c = document.createElement('span');
    c.className = 'participant-chip' + (name === state.learnerName ? ' me' : '');
    c.textContent = name;
    bar.appendChild(c);
  }
}

function setBusy(b) {
  state.busy = b;
  $('#btnSend').disabled = b;
  $('#btnEnd').disabled = b;
  $('#composerStatus').innerHTML = b
    ? '<span class="typing">Thinking <span class="dot"></span><span class="dot"></span><span class="dot"></span></span>'
    : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* =================================================================== */
/* === Transcript export ============================================ */
/* =================================================================== */

function filenameBase() {
  const safe = (state.paperTitle || 'session').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 60) || 'session';
  const d = new Date(); const pad = n => String(n).padStart(2,'0');
  return `literacy-trainer_${safe}_${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function renderTranscriptText() {
  const lines = [];
  lines.push(`Literacy Trainer — Session Transcript`);
  lines.push(`Article: ${state.paperTitle}`);
  if (state.sessionId) lines.push(`Session: ${state.sessionId}`);
  lines.push(`Started: ${new Date(state.transcript[0]?.ts || Date.now()).toLocaleString()}`);
  lines.push('-'.repeat(70));
  for (const e of state.transcript) {
    const tag = e.speaker === 'professor' ? '[Professor]'
              : e.speaker === 'partner'   ? '[Study Partner]'
              : e.speaker === 'learner'   ? `[${e.learner_name || 'Learner'} → ${e.recipient === 'partner' ? 'Study Partner' : 'Professor'}]`
              :                              '[System]';
    lines.push('');
    lines.push(`${new Date(e.ts).toLocaleTimeString()}  ${tag}`);
    lines.push(e.text);
    if (typeof e.score === 'number') lines.push(`  → Score: ${e.score}/10${e.justification ? ' — ' + e.justification : ''}`);
  }
  return lines.join('\n');
}

function renderTranscriptMarkdown() {
  const lines = [];
  lines.push(`# Literacy Trainer — Session Transcript`);
  lines.push('');
  lines.push(`**Article:** ${state.paperTitle}  `);
  if (state.sessionId) lines.push(`**Session:** \`${state.sessionId}\`  `);
  lines.push(`**Started:** ${new Date(state.transcript[0]?.ts || Date.now()).toLocaleString()}`);
  lines.push('');
  lines.push('---');
  for (const e of state.transcript) {
    const tag = e.speaker === 'professor' ? '**The Professor**'
              : e.speaker === 'partner'   ? '**The Study Partner**'
              : e.speaker === 'learner'   ? `**${e.learner_name || 'Learner'} → ${e.recipient === 'partner' ? 'Study Partner' : 'Professor'}**`
              :                              '**System**';
    lines.push('');
    lines.push(`### ${tag} · _${new Date(e.ts).toLocaleTimeString()}_`);
    lines.push('');
    lines.push(e.text);
    if (typeof e.score === 'number') {
      lines.push('');
      lines.push(`> **Score:** ${e.score}/10${e.justification ? ' — ' + e.justification : ''}`);
    }
  }
  return lines.join('\n');
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportMarkdown() {
  // In server mode, prefer the canonical server-side render so observers and
  // the owner export the exact same artifact.
  if (state.mode === 'server' && state.sessionId) {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/transcript.md`);
      if (r.ok) { downloadFile(await r.text(), filenameBase() + '.md', 'text/markdown'); return; }
    } catch (e) {}
  }
  downloadFile(renderTranscriptMarkdown(), filenameBase() + '.md', 'text/markdown');
}

async function exportJson() {
  if (state.mode === 'server' && state.sessionId) {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/transcript.json`);
      if (r.ok) { downloadFile(await r.text(), filenameBase() + '.json', 'application/json'); return; }
    } catch (e) {}
  }
  downloadFile(JSON.stringify({ paperTitle: state.paperTitle, transcript: state.transcript }, null, 2),
    filenameBase() + '.json', 'application/json');
}

/* =================================================================== */
/* === Final report ================================================ */
/* =================================================================== */

function showFinalReport(parsed) {
  const fs = (typeof parsed.final_score === 'number') ? parsed.final_score
          : state.scores.length ? Math.round((state.scores.reduce((a,b)=>a+b.score,0)/state.scores.length)*10)/10
          : '–';
  $('#reportBigScore').textContent = fs + (typeof fs === 'number' ? '/10' : '');
  $('#reportFeedback').textContent = parsed.final_summary || parsed.message || '';
  const sb = $('#reportScoreboard');
  sb.innerHTML = '';
  if (state.scores.length) {
    const t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>#</th><th>Score</th><th>Question</th><th>Note</th></tr></thead>';
    const tb = document.createElement('tbody');
    state.scores.forEach((s,i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i+1}</td><td><b>${s.score}/10</b></td><td>${escapeHtml(s.question)}</td><td>${escapeHtml(s.justification || '')}</td>`;
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    sb.appendChild(t);
  }
  $('#reportModal').classList.remove('hidden');
}

/* =================================================================== */
/* === WebLLM (solo offline mode) =================================== */
/* =================================================================== */
/* The whole WebLLM path is preserved from the original single-file app.
 * It's intentionally walled off from the server code: no fetches, no WS.
 */

async function ensureWebLLM() {
  if (state.webllmEngine && state.webllmReady) return state.webllmEngine;
  if (!navigator.gpu) throw new Error('WebGPU not available in this browser.');
  $('#webllmStatus').textContent = 'Loading WebLLM library…';
  $('#webllmProgressWrap').classList.remove('hidden');
  const webllm = await import('https://esm.run/@mlc-ai/web-llm');
  const onProgress = (report) => {
    const pct = Math.round((report.progress || 0) * 100);
    $('#webllmProgressFill').style.width = pct + '%';
    $('#webllmStatus').textContent = report.text || ('Loading… ' + pct + '%');
    if ($('#composerStatus')) $('#composerStatus').textContent = report.text || ('Loading model… ' + pct + '%');
  };
  state.webllmEngine = await webllm.CreateMLCEngine(state.webllmModelId, { initProgressCallback: onProgress });
  state.webllmReady = true;
  $('#webllmStatus').textContent = '✓ Model loaded (' + state.webllmModelId + ').';
  $('#webllmProgressFill').style.width = '100%';
  return state.webllmEngine;
}

async function callWebllm(systemPrompt, userMessage, opts = {}) {
  const engine = await ensureWebLLM();
  const completion = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: opts.max_tokens || 1200,
    temperature: opts.temperature ?? 0.3,
  });
  return completion.choices?.[0]?.message?.content?.trim() || '';
}

const PROFESSOR_SYSTEM_WEBLLM = (paperTitle, paperText, learnerLevel) => `
You are "The Professor", an experienced academic interrogator running a one-on-one Socratic oral exam.

LEARNER LEVEL: ${learnerLevel}
ARTICLE TITLE: ${paperTitle}
ARTICLE TEXT (authoritative source):
"""
${paperText}
"""

Ask ONE rich, open-ended question at a time. Score each answer 1-10 with a one-sentence justification.
Output STRICT JSON only: {"score": null|number, "score_justification": "...", "message": "...", "topic_tag": "...", "done": false|true, "final_summary": "...", "final_score": null|number}
`.trim();

const PARTNER_SYSTEM_WEBLLM = (paperTitle, paperText, learnerLevel) => `
You are "The Study Partner", a Socratic helper. NEVER give the answer to the Professor's pending question.

LEARNER LEVEL: ${learnerLevel}
ARTICLE TITLE: ${paperTitle}
ARTICLE TEXT:
"""
${paperText}
"""

Plain text. Warm, concise, 2-6 sentences. No JSON.
`.trim();

function buildContextWebllm(forAgent) {
  const lines = ['SESSION TRANSCRIPT SO FAR:'];
  if (state.transcript.length === 0) lines.push('(no messages yet — this is the start of the session)');
  for (const e of state.transcript) {
    const tag = e.speaker === 'professor' ? 'PROFESSOR'
             :  e.speaker === 'partner'   ? 'STUDY_PARTNER'
             :  e.speaker === 'learner'   ? `LEARNER (addressing ${e.recipient === 'partner' ? 'STUDY_PARTNER' : 'PROFESSOR'})`
             :  'SYSTEM';
    lines.push(`\n--- ${tag} ---\n${e.text}`);
    if (typeof e.score === 'number') lines.push(`(Professor scored prior learner answer: ${e.score}/10${e.justification ? ' — ' + e.justification : ''})`);
  }
  const lastProf = [...state.transcript].reverse().find(e => e.speaker === 'professor');
  if (lastProf) {
    lines.push(`\nTHE PROFESSOR'S MOST RECENT MESSAGE TO THE LEARNER (the "pending question" the Study Partner must NOT answer outright):\n"""${lastProf.text}"""`);
  }
  if (forAgent === 'professor') {
    lines.push('\nIt is now YOUR turn (The Professor). JSON output only.');
  } else {
    lines.push('\nIt is now YOUR turn (The Study Partner). Plain text only.');
  }
  return lines.join('\n');
}

function parseLooseJson(text) {
  let t = text.trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i === -1 || j === -1) throw new Error('No JSON object found');
  return JSON.parse(t.slice(i, j+1));
}

async function callProfessorWebllm(isFirstTurn, forceConclude=false) {
  const sys = PROFESSOR_SYSTEM_WEBLLM(state.paperTitle, state.paperText, state.learnerLevel);
  let user = buildContextWebllm('professor');
  if (isFirstTurn) user += '\n\nThis is the FIRST turn. Score=null, done=false.';
  if (forceConclude) user += '\n\nThe learner has chosen to END now. Set done=true with a final_score and final_summary.';
  const raw = await callWebllm(sys, user, { max_tokens: 1400 });
  let parsed;
  try { parsed = parseLooseJson(raw); }
  catch (e) {
    addNote('professor', 'Professor returned non-JSON; showing raw text.');
    addMessageLocal({ speaker: 'professor', text: raw });
    return;
  }

  if (typeof parsed.score === 'number' && !isFirstTurn) {
    const lastLearnerToProf = [...state.transcript].reverse().find(e => e.speaker === 'learner' && (e.recipient === 'professor' || !e.recipient));
    if (lastLearnerToProf) {
      lastLearnerToProf.score = parsed.score;
      lastLearnerToProf.justification = parsed.score_justification || '';
      const node = document.querySelector(`[data-msg-id="${lastLearnerToProf.id}"]`);
      if (node && !node.querySelector('.score-line')) {
        const s = document.createElement('div');
        s.className = 'score-line';
        s.innerHTML = `Score: <strong>${parsed.score}/10</strong>` +
          (parsed.score_justification ? ` · <span style="color:var(--muted)">${escapeHtml(parsed.score_justification)}</span>` : '');
        node.appendChild(s);
      }
      const prevProfQ = [...state.transcript].filter(e => e.speaker === 'professor').slice(-1)[0];
      state.scores.push({
        questionId: lastLearnerToProf.id,
        question: prevProfQ ? prevProfQ.text.slice(0, 200) : '',
        score: parsed.score,
        justification: parsed.score_justification || ''
      });
    }
  }

  if (parsed.message && parsed.message.trim()) {
    addMessageLocal({ speaker: 'professor', text: parsed.message });
  }
  if (parsed.done) {
    state.done = true;
    showFinalReport(parsed);
    $('#btnSend').disabled = true;
    $('#btnEnd').disabled = true;
    $('#composerStatus').textContent = 'Session ended.';
  }
}

async function callPartnerWebllm() {
  const sys = PARTNER_SYSTEM_WEBLLM(state.paperTitle, state.paperText, state.learnerLevel);
  const user = buildContextWebllm('partner');
  const text = await callWebllm(sys, user, { max_tokens: 900, temperature: 0.5 });
  addMessageLocal({ speaker: 'partner', text });
}
