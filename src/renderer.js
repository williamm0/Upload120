'use strict';

// ═══ State ═══════════════════════════════════════════════════════════════

const state = {
  // Patcher
  queue: [],
  history: JSON.parse(localStorage.getItem('history') || '[]'),
  divider: Number(localStorage.getItem('divider')) || 4,
  dividerMode: localStorage.getItem('dividerMode') || 'fixed',
  outputMode: localStorage.getItem('outputMode') || 'suffix',
  suffix: localStorage.getItem('suffix') || '_120fps',
  outputFolder: localStorage.getItem('outputFolder') || null,
  revealAfterPatch: localStorage.getItem('revealAfterPatch') === 'true',
  notify: localStorage.getItem('notify') !== 'false',
  busy: false,
  lastFps: 120,
  lastOutputPath: '',

  // Post composer
  postFile: JSON.parse(localStorage.getItem('postFile') || 'null'),
  caption: localStorage.getItem('caption') || '',
  hashtags: JSON.parse(localStorage.getItem('hashtags') || '[]'),
  privacy: localStorage.getItem('privacy') || 'public',
  allowComments: localStorage.getItem('allowComments') !== 'false',
  allowDuet: localStorage.getItem('allowDuet') !== 'false',
  allowStitch: localStorage.getItem('allowStitch') !== 'false',
  aiContent: localStorage.getItem('aiContent') === 'true',
  branded: localStorage.getItem('branded') === 'true',
  schedule: localStorage.getItem('schedule') || '',
  autoPost: localStorage.getItem('autoPost') !== 'false',

  tikTokConnected: false,
  uploadInProgress: false
};

if (JSON.stringify(state.hashtags) === '["fyp","foryou","foryoupage","viral","120fps","smooth","tiktok"]') {
  state.hashtags = [];
  localStorage.setItem('hashtags', '[]');
}

// ═══ DOM refs ═════════════════════════════════════════════════════════════

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const els = {
  // Patch
  queue: $('#queue'),
  history: $('#history'),
  dropzone: $('#dropzone'),
  dragOverlay: $('#dragOverlay'),
  status: $('#status'),
  processBtn: $('#processBtn'),
  browseBtn: $('#browseBtn'),
  clearQueueBtn: $('#clearQueueBtn'),
  clearHistoryBtn: $('#clearHistoryBtn'),
  resetAllBtn: $('#resetAllBtn'),

  multiplierRow: $('#multiplierRow'),
  segMultiplier: $('#segMultiplier'),
  customDivider: $('#customDivider'),
  stepMinus: $('#stepMinus'),
  stepPlus: $('#stepPlus'),
  multiplierHint: $('#multiplierHint'),
  quickMultiplierHint: $('#quickMultiplierHint'),
  patchQueueCount: $('#patchQueueCount'),
  patchAvgFps: $('#patchAvgFps'),
  patchTargetFps: $('#patchTargetFps'),
  patchDuration: $('#patchDuration'),
  quickOutputMode: $('#quickOutputMode'),
  quickSuffix: $('#quickSuffix'),
  revealAfterPatchToggle: $('#revealAfterPatchToggle'),
  openLastOutputBtn: $('#openLastOutputBtn'),

  outputMode: $('#outputMode'),
  suffix: $('#suffix'),
  outputHint: $('#outputHint'),
  notifyToggle: $('#notifyToggle'),

  versionTag: $('#versionTag'),
  aboutVersion: $('#aboutVersion'),
  toast: $('#toast'),

  // Post
  connectionCard: $('#connectionCard'),
  connectionDot: $('#connectionDot'),
  connectionTitle: $('#connectionTitle'),
  connectionSub: $('#connectionSub'),
  connectionLabel: $('#connectionLabel'),
  connectBtn: $('#connectBtn'),
  disconnectBtn: $('#disconnectBtn'),

  postFile: $('#postFile'),
  postFileEmpty: $('#postFileEmpty'),
  postFileActive: $('#postFileActive'),
  postFileName: $('#postFileName'),
  postFileDetail: $('#postFileDetail'),
  postFileHint: $('#postFileHint'),
  pickPostFileBtn: $('#pickPostFileBtn'),
  changePostFileBtn: $('#changePostFileBtn'),
  revealPostFileBtn: $('#revealPostFileBtn'),

  caption: $('#caption'),
  captionCount: $('#captionCount'),
  hashtagChips: $('#hashtagChips'),
  appendHashtagsBtn: $('#appendHashtagsBtn'),

  newHashtagInput: $('#newHashtagInput'),
  addHashtagBtn: $('#addHashtagBtn'),
  hashtagLibrary: $('#hashtagLibrary'),
  hashtagCount: $('#hashtagCount'),

  privacySeg: $('#privacySeg'),
  allowCommentsToggle: $('#allowCommentsToggle'),
  allowDuetToggle: $('#allowDuetToggle'),
  allowStitchToggle: $('#allowStitchToggle'),
  aiContentToggle: $('#aiContentToggle'),
  brandedToggle: $('#brandedToggle'),
  scheduleInput: $('#scheduleInput'),
  scheduleHint: $('#scheduleHint'),

  copyCaptionBtn: $('#copyCaptionBtn'),
  uploadBtn: $('#uploadBtn'),
  postStatus: $('#postStatus'),
  autoPostToggle: $('#autoPostToggle'),
  uploadProgress: $('#uploadProgress'),
  uploadFill: $('#uploadFill'),
  uploadStage: $('#uploadStage'),
};

// ═══ Utilities ════════════════════════════════════════════════════════════

let nextId = 1;
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDuration = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => (
  { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
));
const cleanTag = (t) => String(t).trim().replace(/^#+/, '').replace(/\s+/g, '').toLowerCase();
const fmtFps = (fps) => {
  if (!Number.isFinite(fps) || fps <= 0) return '-';
  return `${Number(fps.toFixed(fps >= 100 ? 0 : 1)).toLocaleString()} fps`;
};

const setStatus = (text, kind = '') => {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
};
const setPostStatus = (text, kind = '') => {
  els.postStatus.textContent = text;
  els.postStatus.className = `post-status ${kind}`;
};
const showToast = (text, kind = '', ms = 1800) => {
  els.toast.textContent = text;
  els.toast.className = `toast visible ${kind}`;
  els.toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.classList.remove('visible');
    setTimeout(() => { els.toast.hidden = true; }, 300);
  }, ms);
};

const updateProcessBtn = () => {
  const ready = state.queue.filter(q => q.status !== 'done' && q.status !== 'processing' && q.fps).length;
  els.processBtn.disabled = state.busy || ready === 0;
  els.processBtn.querySelector('.btn-label').textContent =
    state.busy ? `Processing…` : ready > 1 ? `Process ${ready}` : `Process`;
};

function updatePatchStats() {
  const total = state.queue.length;
  const ready = state.queue.filter(q => q.status === 'ready' && q.fps).length;
  const withFps = state.queue.filter(q => Number.isFinite(q.fps) && q.fps > 0);

  els.patchQueueCount.textContent = total === 0
    ? '0 files'
    : `${total} file${total === 1 ? '' : 's'} · ${ready} ready`;

  if (withFps.length === 0) {
    els.patchAvgFps.textContent = '-';
    els.patchTargetFps.textContent = '-';
    els.patchDuration.textContent = '0:00';
    return;
  }

  const avgFps = withFps.reduce((sum, q) => sum + q.fps, 0) / withFps.length;
  const avgTargetFps = withFps.reduce((sum, q) => sum + (q.fps * pickDivider(q.fps)), 0) / withFps.length;
  const totalDuration = withFps.reduce((sum, q) => sum + (q.durationSec || 0), 0);

  els.patchAvgFps.textContent = fmtFps(avgFps);
  els.patchTargetFps.textContent = fmtFps(avgTargetFps);
  els.patchDuration.textContent = fmtDuration(totalDuration);
}

// ═══ View switching ══════════════════════════════════════════════════════

function showView(name) {
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  if (name === 'post') refreshTikTokStatus();
}
$$('.nav-item').forEach(n => n.addEventListener('click', () => showView(n.dataset.view)));

// ═══ Patch: Queue ═════════════════════════════════════════════════════════

function renderQueue() {
  if (state.queue.length === 0) {
    els.queue.innerHTML = `
      <div class="queue-empty">
        <div class="qe-icon">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 4l14 8-14 8V4z" fill="currentColor" opacity="0.5"/></svg>
        </div>
        <div class="qe-text">No files yet  -  drop a video above</div>
      </div>`;
    updatePatchStats();
    return;
  }
  els.queue.innerHTML = '';
  for (const q of state.queue) {
    const item = document.createElement('div');
    item.className = `q-item ${q.status === 'done' ? 'ok' : q.status === 'error' ? 'err' : ''}`;
    item.dataset.id = q.id;

    const meta = q.error ? q.error
      : q.fps ? `${q.w}×${q.h} · ${fmtDuration(q.durationSec)} · ${fmtBytes(q.size)}`
      : `Reading…`;
    const fpsTag = q.fps ? `<span class="q-fps">${q.fps}</span>` : '';

    item.innerHTML = `
      <div class="q-thumb">
        <svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 4l14 8-14 8V4z" fill="currentColor"/></svg>
      </div>
      <div class="q-name">
        <div class="nm">${escapeHtml(q.name)}</div>
        <div class="meta">${escapeHtml(meta)}</div>
      </div>
      <div class="q-actions">
        ${fpsTag}
        ${q.status === 'done' ? `<button class="q-action" data-act="post" title="Post this video">
          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M3 11l18-7-7 18-2-7-9-4z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>
        </button>` : ''}
        ${q.status === 'done' ? `<button class="q-action" data-act="reveal" title="Show in folder">
          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>
        </button>` : ''}
        <button class="q-action" data-act="remove" title="Remove">
          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="q-progress" style="width: ${q.progress || 0}%"></div>
    `;
    els.queue.appendChild(item);
  }
  els.queue.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.closest('.q-item').dataset.id);
      const q = state.queue.find(x => x.id === id);
      if (!q) return;
      if (btn.dataset.act === 'remove') removeFromQueue(id);
      if (btn.dataset.act === 'reveal' && q.output) window.api.reveal(q.output);
      if (btn.dataset.act === 'post' && q.output) {
        attachPostFile({ path: q.output, fps: q.fps, w: q.w, h: q.h, durationSec: q.durationSec, size: q.size });
        showView('post');
      }
    });
  });
  updatePatchStats();
}

function renderHistory() {
  if (state.history.length === 0) {
    els.history.innerHTML = `<div class="history-item"><div class="h-empty">No recent files</div></div>`;
    return;
  }
  els.history.innerHTML = '';
  state.history.slice(0, 8).forEach(h => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="h-name">${escapeHtml(window.api.basename(h.output))}</span>
      <span class="h-tag">${h.fps}×${Math.round(h.effective / Math.max(1, h.fps))}</span>
    `;
    item.title = h.output;
    item.addEventListener('click', () => window.api.reveal(h.output));
    els.history.appendChild(item);
  });
}

function pushHistory(entry) {
  state.history.unshift(entry);
  if (state.history.length > 24) state.history = state.history.slice(0, 24);
  localStorage.setItem('history', JSON.stringify(state.history));
  renderHistory();
}

async function addFiles(paths) {
  const newOnes = [];
  for (const p of paths) {
    if (state.queue.some(q => q.path === p)) continue;
    const q = {
      id: nextId++,
      path: p,
      name: window.api.basename(p),
      size: 0, fps: 0,
      status: 'reading', progress: 0
    };
    state.queue.push(q);
    newOnes.push(q);
  }
  renderQueue();
  updateProcessBtn();
  for (const q of newOnes) await inspectQueueItem(q);
  updateProcessBtn();
  setStatus(state.queue.length > 0
    ? `${state.queue.length} file${state.queue.length === 1 ? '' : 's'} ready`
    : 'Ready');
}

async function inspectQueueItem(q) {
  const info = await window.api.inspectMp4(q.path);
  if (!info.ok || !info.isMp4) {
    q.status = 'error';
    q.error = info.error || 'Unsupported file';
    renderQueue();
    return;
  }
  q.size = info.size;
  q.fps = info.fps;
  q.frameCount = info.frameCount;
  q.durationSec = info.durationSec;
  q.w = info.width;
  q.h = info.height;
  q.status = 'ready';
  if (q.fps) state.lastFps = q.fps;
  renderQueue();
}

function removeFromQueue(id) {
  state.queue = state.queue.filter(q => q.id !== id);
  renderQueue();
  updateProcessBtn();
  setStatus(state.queue.length > 0
    ? `${state.queue.length} file${state.queue.length === 1 ? '' : 's'} ready`
    : 'Ready');
}

function clearQueue() {
  if (state.busy) return;
  state.queue = [];
  renderQueue();
  updateProcessBtn();
  setStatus('Ready');
}

async function resolveOutputPath(q) {
  const parsed = window.api.parsePath(q.path);
  const safeBase = parsed.name + (state.suffix || '_120fps') + '.mp4';
  if (state.outputMode === 'ask') return await window.api.saveAs(safeBase);
  if (state.outputMode === 'folder') {
    if (!state.outputFolder) {
      const f = await window.api.saveFolder();
      if (!f) return null;
      state.outputFolder = f;
      localStorage.setItem('outputFolder', f);
      updateOutputHint();
    }
    return window.api.joinPath(state.outputFolder, safeBase);
  }
  return window.api.joinPath(parsed.dir, safeBase);
}

function pickDivider(fps) {
  if (state.dividerMode === 'fixed') return state.divider;
  if (fps >= 100) return 4;
  if (fps >= 75)  return 3;
  return 2;
}

async function processAll() {
  if (state.busy) return;
  const todo = state.queue.filter(q => q.status === 'ready' && q.fps);
  if (todo.length === 0) { setStatus('Nothing to process', 'error'); return; }
  state.busy = true;
  updateProcessBtn();
  let okCount = 0, failCount = 0;
  let lastDone = null;

  for (const q of todo) {
    setStatus(`Processing ${q.name}…`, 'busy');
    q.status = 'processing'; q.progress = 14; renderQueue();

    const output = await resolveOutputPath(q);
    if (!output) { q.status = 'ready'; q.progress = 0; renderQueue(); continue; }
    q.progress = 35; renderQueue();

    const div = pickDivider(q.fps);
    const result = await window.api.patchMp4({
      input: q.path, output, divider: div, fps: q.fps
    });
    if (!result.ok) {
      q.status = 'error'; q.error = result.error; q.progress = 0;
      failCount++;
    } else {
      q.status = 'done'; q.output = result.output; q.progress = 100;
      state.lastOutputPath = result.output;
      pushHistory({
        input: q.path, output: result.output,
        fps: q.fps, effective: q.fps * div, ts: Date.now()
      });
      if (state.revealAfterPatch) window.api.reveal(result.output);
      okCount++;
      lastDone = q;
    }
    renderQueue();
  }

  state.busy = false;
  updateProcessBtn();
  if (okCount > 0 && failCount === 0) {
    setStatus(`Done · ${okCount} file${okCount === 1 ? '' : 's'} patched`, 'success');
    if (state.notify) window.api.notify({
      title: 'Upload120',
      body: `${okCount} video${okCount === 1 ? '' : 's'} ready to upload from a computer`
    });
    // Auto-attach last patched file to Post composer
    if (lastDone && !state.postFile) {
      attachPostFile({ path: lastDone.output, fps: lastDone.fps, w: lastDone.w, h: lastDone.h, durationSec: lastDone.durationSec });
    }
  } else if (okCount > 0) setStatus(`${okCount} done · ${failCount} failed`, 'error');
  else setStatus(`Failed`, 'error');
}

// ═══ Drag and drop ════════════════════════════════════════════════════════

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  els.dragOverlay.classList.add('visible');
  els.dropzone.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    els.dragOverlay.classList.remove('visible');
    els.dropzone.classList.remove('dragging');
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dragOverlay.classList.remove('visible');
  els.dropzone.classList.remove('dragging');
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  const paths = [];
  for (const f of e.dataTransfer.files) if (f.path) paths.push(f.path);
  if (paths.length) {
    showView('patch');
    await addFiles(paths);
  }
});

// ═══ Patch: Wire controls ════════════════════════════════════════════════

els.dropzone.addEventListener('click', async () => {
  const paths = await window.api.openFiles();
  if (paths.length) await addFiles(paths);
});
els.browseBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const paths = await window.api.openFiles();
  if (paths.length) await addFiles(paths);
});
els.clearQueueBtn.addEventListener('click', clearQueue);
els.clearHistoryBtn.addEventListener('click', () => {
  state.history = [];
  localStorage.setItem('history', '[]');
  renderHistory();
  showToast('History cleared');
});
els.processBtn.addEventListener('click', processAll);

// Patch view: visual multiplier cards
els.multiplierRow.querySelectorAll('.mult-card').forEach(card => {
  card.addEventListener('click', () => {
    const v = card.dataset.divider;
    setDivider(v);
  });
});

// Settings: segmented multiplier
els.segMultiplier.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', () => setDivider(seg.dataset.divider));
});

// Stepper
els.stepMinus.addEventListener('click', () => setCustomDivider(state.divider - 1));
els.stepPlus.addEventListener('click', () => setCustomDivider(state.divider + 1));
els.customDivider.addEventListener('change', () => setCustomDivider(Number(els.customDivider.value)));

function setDivider(value) {
  if (value === 'auto') {
    state.dividerMode = 'auto';
  } else {
    state.dividerMode = 'fixed';
    state.divider = Math.max(2, Math.min(16, Number(value) || 4));
    els.customDivider.value = state.divider;
  }
  syncMultiplierUI();
  localStorage.setItem('dividerMode', state.dividerMode);
  localStorage.setItem('divider', String(state.divider));
}
function setCustomDivider(v) {
  v = Math.max(2, Math.min(16, Math.round(v) || 4));
  state.dividerMode = 'fixed';
  state.divider = v;
  els.customDivider.value = v;
  syncMultiplierUI();
  localStorage.setItem('dividerMode', 'fixed');
  localStorage.setItem('divider', String(v));
}
function syncMultiplierUI() {
  const target = state.dividerMode === 'auto' ? 'auto' : String(state.divider);
  els.multiplierRow.querySelectorAll('.mult-card').forEach(c => {
    c.classList.toggle('active', c.dataset.divider === target);
  });
  els.segMultiplier.querySelectorAll('.seg').forEach(s => {
    s.classList.toggle('active', s.dataset.divider === target);
  });
  if (state.dividerMode === 'auto') {
    els.multiplierHint.textContent = 'Auto  -  picks 2× for 60 fps, 3× for 90, 4× for 120+ per file.';
    els.quickMultiplierHint.textContent = 'Auto per file';
  } else {
    const examples = {
      2: '60 fps source becomes 120 fps apparent.',
      3: '90 fps becomes 270, 60 becomes 180.',
      4: '120 fps source becomes 480 fps apparent.',
    };
    els.multiplierHint.textContent = examples[state.divider] ||
      `${state.divider}×  -  multiplies apparent smoothness.`;
    els.quickMultiplierHint.textContent = state.divider === 4 ? '120 fps preset' : `${state.divider}× preset`;
  }
  updatePatchStats();
}

els.outputMode.value = state.outputMode;
if (els.quickOutputMode) els.quickOutputMode.value = state.outputMode;

async function setOutputMode(nextMode) {
  state.outputMode = nextMode;
  els.outputMode.value = nextMode;
  if (els.quickOutputMode) els.quickOutputMode.value = nextMode;
  localStorage.setItem('outputMode', state.outputMode);
  if (state.outputMode === 'folder') {
    const f = await window.api.saveFolder();
    if (f) {
      state.outputFolder = f;
      localStorage.setItem('outputFolder', f);
    }
  }
  updateOutputHint();
}

els.outputMode.addEventListener('change', async () => {
  await setOutputMode(els.outputMode.value);
});
if (els.quickOutputMode) {
  els.quickOutputMode.addEventListener('change', async () => {
    await setOutputMode(els.quickOutputMode.value);
  });
}

els.suffix.value = state.suffix;
if (els.quickSuffix) els.quickSuffix.value = state.suffix;

function setSuffix(nextSuffix) {
  state.suffix = nextSuffix || '_patched';
  els.suffix.value = state.suffix;
  if (els.quickSuffix) els.quickSuffix.value = state.suffix;
  localStorage.setItem('suffix', state.suffix);
  updateOutputHint();
}

els.suffix.addEventListener('input', () => {
  setSuffix(els.suffix.value);
});
if (els.quickSuffix) {
  els.quickSuffix.addEventListener('input', () => {
    setSuffix(els.quickSuffix.value);
  });
}

if (els.revealAfterPatchToggle) {
  els.revealAfterPatchToggle.checked = state.revealAfterPatch;
  els.revealAfterPatchToggle.addEventListener('change', () => {
    state.revealAfterPatch = els.revealAfterPatchToggle.checked;
    localStorage.setItem('revealAfterPatch', String(state.revealAfterPatch));
  });
}
if (els.openLastOutputBtn) {
  els.openLastOutputBtn.addEventListener('click', () => {
    if (state.lastOutputPath) window.api.reveal(state.lastOutputPath);
    else showToast('No patched output yet');
  });
}

els.notifyToggle.checked = state.notify;
els.notifyToggle.addEventListener('change', () => {
  state.notify = els.notifyToggle.checked;
  localStorage.setItem('notify', String(state.notify));
});

function updateOutputHint() {
  if (els.quickOutputMode) els.quickOutputMode.value = state.outputMode;
  if (els.quickSuffix) els.quickSuffix.value = state.suffix;
  if (state.outputMode === 'ask') {
    els.outputHint.textContent = 'A save dialog opens for each file.';
  } else if (state.outputMode === 'folder') {
    const f = state.outputFolder ? window.api.basename(state.outputFolder) : 'not chosen';
    els.outputHint.innerHTML = `Folder: <span class="mono">${escapeHtml(f)}</span>`;
  } else {
    els.outputHint.innerHTML = `Same folder as the source · <span class="mono">${escapeHtml(state.suffix)}</span>`;
  }
}

if (els.resetAllBtn) els.resetAllBtn.addEventListener('click', () => {
  if (!confirm('Reset all settings, history, and saved hashtags? This cannot be undone.')) return;
  ['history','divider','dividerMode','outputMode','suffix','outputFolder','revealAfterPatch','notify',
   'caption','hashtags','privacy','allowComments','allowDuet','allowStitch',
   'aiContent','branded','schedule','postFile'].forEach(k => localStorage.removeItem(k));
  showToast('Reset complete  -  restart for a clean state');
});

// ═══ Post: TikTok connection ═════════════════════════════════════════════

let waitingForLoginPopup = false;
async function refreshTikTokStatus() {
  const previous = state.tikTokConnected;
  try {
    const r = await window.api.tiktokStatus();
    state.tikTokConnected = !!r.loggedIn;
  } catch { state.tikTokConnected = false; }
  syncConnectionUI();
  if (waitingForLoginPopup && !previous && state.tikTokConnected) {
    waitingForLoginPopup = false;
    window.api.showInfo({
      title: 'Upload120',
      message: "You're signed in.",
      detail: 'It is okay to close the TikTok window now.'
    });
  }
}

function syncConnectionUI() {
  if (state.tikTokConnected) {
    els.connectionCard.classList.add('connected');
    els.connectionTitle.textContent = 'TikTok connected';
    els.connectionSub.textContent = 'Your TikTok session is saved. Uploads stay inside Upload120.';
    els.connectionLabel.textContent = 'Connected';
    els.connectBtn.textContent = 'Refresh session';
    els.disconnectBtn.hidden = false;
  } else {
    els.connectionCard.classList.remove('connected');
    els.connectionTitle.textContent = 'Not connected';
    els.connectionSub.textContent = 'Sign in once  -  Upload120 keeps the session for later uploads.';
    els.connectionLabel.textContent = 'Disconnected';
    els.connectBtn.textContent = 'Connect TikTok';
    els.disconnectBtn.hidden = true;
  }
}

els.connectBtn.addEventListener('click', async () => {
  await window.api.tiktokOpenLogin();
  setTimeout(refreshTikTokStatus, 2000);
  setTimeout(refreshTikTokStatus, 8000);
  setTimeout(refreshTikTokStatus, 20000);
});
els.disconnectBtn.addEventListener('click', async () => {
  if (!confirm('Disconnect TikTok? Cookies and login state will be cleared.')) return;
  await window.api.tiktokLogout();
  waitingForLoginPopup = false;
  state.tikTokConnected = false;
  syncConnectionUI();
  showToast('Disconnected from TikTok');
});

// ═══ Post: File selection ════════════════════════════════════════════════

function attachPostFile(file) {
  if (!file || !file.path) return;
  state.postFile = file;
  localStorage.setItem('postFile', JSON.stringify(file));
  renderPostFile();
}
function clearPostFile() {
  state.postFile = null;
  localStorage.removeItem('postFile');
  renderPostFile();
}
function renderPostFile() {
  if (state.postFile && state.postFile.path) {
    els.postFileEmpty.hidden = true;
    els.postFileActive.hidden = false;
    els.postFileName.textContent = window.api.basename(state.postFile.path);
    const parts = [];
    if (state.postFile.fps) parts.push(`${state.postFile.fps} fps`);
    if (state.postFile.w && state.postFile.h) parts.push(`${state.postFile.w}×${state.postFile.h}`);
    if (state.postFile.durationSec) parts.push(fmtDuration(state.postFile.durationSec));
    if (state.postFile.size) parts.push(fmtBytes(state.postFile.size));
    els.postFileDetail.textContent = parts.join(' · ') || state.postFile.path;
    els.postFileHint.textContent = 'Ready';
  } else {
    els.postFileEmpty.hidden = false;
    els.postFileActive.hidden = true;
    els.postFileHint.textContent = 'No file selected';
  }
}

els.pickPostFileBtn.addEventListener('click', async () => {
  const r = await window.api.pickVideo();
  if (r) {
    const meta = await window.api.inspectMp4(r.path);
    attachPostFile({
      path: r.path,
      size: r.size,
      fps: meta.ok ? meta.fps : 0,
      w: meta.ok ? meta.width : 0,
      h: meta.ok ? meta.height : 0,
      durationSec: meta.ok ? meta.durationSec : 0
    });
  }
});
els.changePostFileBtn.addEventListener('click', () => els.pickPostFileBtn.click());
els.revealPostFileBtn.addEventListener('click', () => {
  if (state.postFile && state.postFile.path) window.api.reveal(state.postFile.path);
});

// ═══ Post: Caption + hashtags ════════════════════════════════════════════

function buildHashtagString(tags) {
  return (tags || []).map(t => '#' + cleanTag(t)).filter(t => t.length > 1).join(' ');
}
function getCaptionWithTags() {
  const cap = els.caption.value.trim();
  const tags = buildHashtagString(state.hashtags);
  if (!cap) return tags;
  if (!tags) return cap;
  return cap + '\n\n' + tags;
}

function renderHashtagChips() {
  const top = state.hashtags.slice(0, 6);
  if (top.length === 0) {
    els.hashtagChips.innerHTML = `<span class="chip-mini empty">Click Add to save hashtags</span>`;
    return;
  }
  els.hashtagChips.innerHTML = top.map(t =>
    `<button class="chip-mini" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`
  ).join('');
  els.hashtagChips.querySelectorAll('[data-tag]').forEach(b => {
    b.addEventListener('click', () => insertHashtag(b.dataset.tag));
  });
}
function insertHashtag(tag) {
  const t = '#' + cleanTag(tag);
  const cur = els.caption.value;
  const sep = cur && !cur.endsWith(' ') && !cur.endsWith('\n') ? ' ' : '';
  els.caption.value = cur + sep + t + ' ';
  els.caption.focus();
  saveCaption();
}
function appendAllSavedHashtags() {
  const tagStr = buildHashtagString(state.hashtags);
  if (!tagStr) return;
  const cur = els.caption.value.trim();
  els.caption.value = cur ? cur + '\n\n' + tagStr : tagStr;
  saveCaption();
  showToast(`${state.hashtags.length} hashtag${state.hashtags.length === 1 ? '' : 's'} added`);
}

function renderHashtagLibrary() {
  els.hashtagCount.textContent = `${state.hashtags.length} saved`;
  if (state.hashtags.length === 0) {
    els.hashtagLibrary.innerHTML = '<span class="chip-mini empty">No saved hashtags yet. Type one above, then click Add.</span>';;
    return;
  }
  els.hashtagLibrary.innerHTML = state.hashtags.map(t => `
    <span class="tag-pill">#${escapeHtml(t)}<button class="tag-x" data-remove="${escapeHtml(t)}" title="Remove">×</button></span>
  `).join('');
  els.hashtagLibrary.querySelectorAll('[data-remove]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      removeHashtag(b.dataset.remove);
    });
  });
}
function addHashtag(raw) {
  const tags = String(raw).split(/[\s,#]+/).map(cleanTag).filter(t => t.length > 0);
  if (tags.length === 0) return;
  for (const t of tags) {
    if (!state.hashtags.includes(t)) state.hashtags.push(t);
  }
  saveHashtags();
}
function removeHashtag(tag) {
  state.hashtags = state.hashtags.filter(t => t !== tag);
  saveHashtags();
}
function saveHashtags() {
  localStorage.setItem('hashtags', JSON.stringify(state.hashtags));
  renderHashtagLibrary();
  renderHashtagChips();
}

els.addHashtagBtn.addEventListener('click', () => {
  if (!els.newHashtagInput.value.trim()) return;
  addHashtag(els.newHashtagInput.value);
  els.newHashtagInput.value = '';
  els.newHashtagInput.focus();
});
els.newHashtagInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.addHashtagBtn.click();
});
els.appendHashtagsBtn.addEventListener('click', appendAllSavedHashtags);

function saveCaption() {
  state.caption = els.caption.value;
  localStorage.setItem('caption', state.caption);
  els.captionCount.textContent = String(els.caption.value.length);
}
els.caption.addEventListener('input', saveCaption);

// ═══ Post: Options ═══════════════════════════════════════════════════════

els.privacySeg.querySelectorAll('.seg').forEach(seg => {
  seg.addEventListener('click', () => {
    els.privacySeg.querySelectorAll('.seg').forEach(s => s.classList.remove('active'));
    seg.classList.add('active');
    state.privacy = seg.dataset.privacy;
    localStorage.setItem('privacy', state.privacy);
  });
});

function bindToggle(toggleEl, key) {
  toggleEl.addEventListener('change', () => {
    state[key] = toggleEl.checked;
    localStorage.setItem(key, String(toggleEl.checked));
  });
}
bindToggle(els.allowCommentsToggle, 'allowComments');
bindToggle(els.allowDuetToggle, 'allowDuet');
bindToggle(els.allowStitchToggle, 'allowStitch');
bindToggle(els.aiContentToggle, 'aiContent');
bindToggle(els.brandedToggle, 'branded');

els.scheduleInput.addEventListener('change', () => {
  state.schedule = els.scheduleInput.value || '';
  localStorage.setItem('schedule', state.schedule);
  if (state.schedule) {
    const d = new Date(state.schedule);
    els.scheduleHint.textContent = `Reminder set for ${d.toLocaleString()}`;
  } else {
    els.scheduleHint.textContent = 'Off. Post now.';
  }
});

// ═══ Post: Upload actions ════════════════════════════════════════════════

els.copyCaptionBtn.addEventListener('click', async () => {
  const text = getCaptionWithTags();
  if (!text) { showToast('Nothing to copy'); return; }
  await window.api.copy(text);
  showToast('Caption copied to clipboard', 'success');
});

els.autoPostToggle.checked = state.autoPost;
els.autoPostToggle.addEventListener('change', () => {
  state.autoPost = els.autoPostToggle.checked;
  localStorage.setItem('autoPost', String(state.autoPost));
});

function setProgress(percent, stageText) {
  els.uploadProgress.hidden = false;
  els.uploadFill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  if (stageText) els.uploadStage.textContent = stageText;
}
function hideProgress() { els.uploadProgress.hidden = true; }

els.uploadBtn.addEventListener('click', async () => {
  if (state.uploadInProgress) {
    await window.api.tiktokFocus();
    return;
  }
  if (!state.postFile || !state.postFile.path) {
    setPostStatus('Pick a video first.', 'error');
    return;
  }
  state.uploadInProgress = true;
  els.uploadBtn.disabled = true;
  els.uploadBtn.querySelector('.btn-label').textContent = 'Uploading…';
  setPostStatus('', '');
  setProgress(4, 'Starting…');

  const captionFinal = getCaptionWithTags();
  const r = await window.api.tiktokUpload({
    filePath: state.postFile.path,
    caption: captionFinal,
    autoPost: state.autoPost,
    options: {
      privacy: state.privacy,
      allowComments: state.allowComments,
      allowDuet: state.allowDuet,
      allowStitch: state.allowStitch
    }
  });

  state.uploadInProgress = false;
  els.uploadBtn.disabled = false;
  els.uploadBtn.querySelector('.btn-label').textContent = 'Upload to TikTok';

  if (r && r.ok && r.autoPosted) {
    setProgress(100, 'Posted ✓');
    setPostStatus('Posted to TikTok.', 'success');
    showToast('Posted to TikTok ✓', 'success');
    if (state.notify) window.api.notify({
      title: 'Upload120',
      body: 'Your video is live on TikTok.'
    });
    state.tikTokConnected = true;
    syncConnectionUI();
    setTimeout(hideProgress, 2200);
  } else if (r && r.ok && r.pending) {
    setProgress(95, 'Posting…');
    setPostStatus('Posting started. TikTok is finalising. Check the TikTok window.', 'success');
    state.tikTokConnected = true;
    syncConnectionUI();
  } else if (r && r.ok) {
    setProgress(95, 'Ready');
    setPostStatus('Composer ready in the TikTok window. Click Post when ready.', 'success');
    state.tikTokConnected = true;
    syncConnectionUI();
  } else if (r && r.needsLogin) {
    hideProgress();
    setPostStatus('Sign in to TikTok, then try again.', 'error');
    state.tikTokConnected = false;
    syncConnectionUI();
  } else {
    hideProgress();
    setPostStatus(r && r.error ? `Upload failed: ${r.error}` : 'Upload failed.', 'error');
  }
});

// TikTok event stream from main
const stageMap = {
  'login-detected':     { msg: 'Logged in  -  session saved.',    pct: 0, kind: 'success' },
  'opening':            { msg: 'Opening TikTok…',                pct: 8 },
  'page-loaded':        { msg: 'Page loaded.',                   pct: 18 },
  'needs-login':        { msg: 'TikTok session needs another check.', pct: 0,  kind: 'error' },
  'waiting-file-input': { msg: 'Waiting for upload area…',       pct: 24 },
  'attaching-file':     { msg: 'Attaching your video…',          pct: 38 },
  'waiting-editor':     { msg: 'Uploading & waiting for editor…',pct: 60 },
  'inserting-caption':  { msg: 'Pre-filling caption…',           pct: 72 },
  'caption-inserted':   { msg: 'Caption inserted.',              pct: 78 },
  'setting-options':    { msg: 'Applying options…',              pct: 84 },
  'waiting-post-ready': { msg: 'Waiting for Post to be ready…',  pct: 88 },
  'posting':            { msg: 'Posting…',                       pct: 94 },
  'posted':             { msg: 'Posted ✓',                       pct: 100, kind: 'success' },
  'ready':              { msg: 'Composer ready.',                pct: 95,  kind: 'success' },
  'post-pending':       { msg: 'Posting in progress…',           pct: 96 },
  'post-button-failed': { msg: 'Could not auto-click Post. Review in window.', pct: 90, kind: 'error' },
  'error':              { msg: 'Error during upload.',           pct: 0,   kind: 'error' }
};

window.api.onTikTokEvent((ev) => {
  if (!ev || !ev.stage) return;
  if (ev.stage === 'login-detected') {
    refreshTikTokStatus();
    showToast('Signed in to TikTok ✓', 'success');
    return;
  }
  const m = stageMap[ev.stage];
  if (!m) return;
  setProgress(m.pct, m.msg);
  if (m.kind) setPostStatus(ev.message || m.msg, m.kind);
});

// ═══ External links ══════════════════════════════════════════════════════

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-link]');
  if (a) {
    e.preventDefault();
    window.api.openExternal(a.dataset.link);
  }
  const v = e.target.closest('[data-link-view]');
  if (v) {
    e.preventDefault();
    showView(v.dataset.linkView);
  }
});

// ═══ Menu wiring ═════════════════════════════════════════════════════════

window.api.onMenu('menu:openFile', async () => {
  const paths = await window.api.openFiles();
  if (paths.length) { showView('patch'); await addFiles(paths); }
});
window.api.onMenu('menu:openFolder', async () => {
  const paths = await window.api.openFolder();
  if (paths.length) { showView('patch'); await addFiles(paths); }
});
window.api.onMenu('menu:clearQueue', clearQueue);
window.api.onMenu('menu:showAbout', () => showView('about'));
window.api.onMenu('menu:showHelp', () => showView('about'));

// ═══ Init ════════════════════════════════════════════════════════════════

(async () => {
  const v = await window.api.getVersion();
  els.versionTag.textContent = 'Version ' + v;
  els.aboutVersion.textContent = 'Version ' + v;

  // Patcher state
  if (state.history[0] && state.history[0].output) {
    state.lastOutputPath = state.history[0].output;
  }
  syncMultiplierUI();
  updateOutputHint();
  renderHistory();
  renderQueue();
  setStatus('Ready');

  // Composer state
  els.caption.value = state.caption;
  els.captionCount.textContent = String(state.caption.length);
  renderHashtagLibrary();
  renderHashtagChips();
  renderPostFile();
  // Privacy
  els.privacySeg.querySelectorAll('.seg').forEach(s => {
    s.classList.toggle('active', s.dataset.privacy === state.privacy);
  });
  els.allowCommentsToggle.checked = state.allowComments;
  els.allowDuetToggle.checked = state.allowDuet;
  els.allowStitchToggle.checked = state.allowStitch;
  els.aiContentToggle.checked = state.aiContent;
  els.brandedToggle.checked = state.branded;
  els.scheduleInput.value = state.schedule || '';
  if (state.schedule) {
    els.scheduleHint.textContent = `Reminder set for ${new Date(state.schedule).toLocaleString()}`;
  }

  // TikTok status
  refreshTikTokStatus();
})();
