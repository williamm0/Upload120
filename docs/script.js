(() => {
  'use strict';

  const patcher = window.Upload120Patcher;
  const dropzone = document.querySelector('#dropzone');
  const browseBtn = document.querySelector('#browseBtn');
  const fileInput = document.querySelector('#fileInput');
  const queueEl = document.querySelector('#queue');
  const processBtn = document.querySelector('#processBtn');
  const clearQueueBtn = document.querySelector('#clearQueueBtn');
  const multiplierRow = document.querySelector('#multiplierRow');
  const customMultiplier = document.querySelector('#customMultiplier');
  const suffixInput = document.querySelector('#suffixInput');
  const autoDownloadInput = document.querySelector('#autoDownloadInput');
  const modeHint = document.querySelector('#modeHint');
  const navItems = [...document.querySelectorAll('[data-nav]')];

  let selectedMode = 'auto';
  let queue = [];
  let nextId = 1;

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function formatFps(fps) {
    if (!Number.isFinite(fps) || fps <= 0) return 'Unknown';
    return `${Number(fps.toFixed(3)).toLocaleString()} fps`;
  }

  function getMultiplier() {
    if (selectedMode === 'auto') return 1;
    if (selectedMode === 'custom') return Math.max(2, Math.min(16, Number(customMultiplier.value) || 2));
    return Number(selectedMode);
  }

  function modeLabel(item) {
    if (item.mode === 'auto') return 'Auto';
    if (item.mode === 'custom') return `${item.multiplier}x custom`;
    return `${item.multiplier}x`;
  }

  function effectiveFps(item) {
    return item.info?.fps ? item.info.fps * item.multiplier : 0;
  }

  function outputName(name) {
    const suffix = suffixInput.value.trim() || '_120fps';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}${suffix}`;
    return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  }

  function allowedFile(file) {
    return /\.(mp4|mov|m4v)$/i.test(file.name) || /video\/(mp4|quicktime)/i.test(file.type);
  }

  function renderQueue() {
    processBtn.disabled = queue.length === 0 || queue.every(item => item.status === 'done' || item.status === 'error');

    if (queue.length === 0) {
      queueEl.innerHTML = '<div class="queue-empty">No files yet. Drop a video above.</div>';
      return;
    }

    queueEl.innerHTML = queue.map(item => {
      const info = item.info || {};
      const resolution = info.width && info.height ? `${info.width} x ${info.height}` : 'Unknown';
      const statusClass = item.status === 'done' ? 'done' : item.status === 'error' ? 'error' : '';
      const download = item.url
        ? `<a class="download-btn" href="${item.url}" download="${item.outputName}">Download</a>`
        : '<span class="metric-value">-</span>';
      return `
        <div class="queue-row" data-id="${item.id}">
          <div>
            <div class="file-name">${escapeHtml(item.file.name)}</div>
            <div class="file-sub">${formatBytes(item.file.size)} / ${escapeHtml(item.file.type || 'video file')}</div>
          </div>
          <div><div class="metric-label">Detected FPS</div><div class="metric-value">${formatFps(info.fps)}</div></div>
          <div><div class="metric-label">Resolution</div><div class="metric-value">${resolution}</div></div>
          <div><div class="metric-label">Mode</div><div class="metric-value">${modeLabel(item)}</div></div>
          <div><div class="metric-label">Output FPS</div><div class="metric-value">${formatFps(effectiveFps(item))}</div></div>
          <div><div class="metric-label">Status</div><div class="status-pill ${statusClass}">${escapeHtml(item.message || item.status)}</div></div>
          <div>${download}</div>
        </div>`;
    }).join('');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  async function addFiles(files) {
    const accepted = [...files].filter(allowedFile);
    for (const file of accepted) {
      const multiplier = getMultiplier();
      const item = {
        id: nextId++,
        file,
        mode: selectedMode,
        multiplier,
        status: 'Inspecting',
        message: 'Inspecting',
        info: null,
        url: '',
        outputName: outputName(file.name)
      };
      queue.push(item);
      renderQueue();

      try {
        const buffer = await file.arrayBuffer();
        item.sourceBuffer = buffer;
        const info = patcher.inspectMp4(buffer);
        item.info = info;
        if (!info.isMp4 || info.error) throw new Error(info.error || 'Unsupported video container.');
        item.status = 'ready';
        item.message = 'Ready';
      } catch (error) {
        item.status = 'error';
        item.message = error.message || 'Could not inspect file';
      }
      renderQueue();
    }
  }

  async function processQueue() {
    processBtn.disabled = true;
    for (const item of queue) {
      if (item.status !== 'ready') continue;
      item.status = 'processing';
      item.message = 'Processing';
      renderQueue();

      try {
        const result = patcher.patchMp4Buffer(item.sourceBuffer, item.multiplier);
        const blob = new Blob([result.bytes], { type: item.file.type || 'video/mp4' });
        if (item.url) URL.revokeObjectURL(item.url);
        item.outputName = outputName(item.file.name);
        item.url = URL.createObjectURL(blob);
        item.status = 'done';
        item.message = `Done / mvhd ${result.mvhdCount}, mdhd ${result.mdhdCount}`;
        if (autoDownloadInput.checked) triggerDownload(item);
      } catch (error) {
        item.status = 'error';
        item.message = error.message || 'Patch failed';
      }
      renderQueue();
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    renderQueue();
  }

  function triggerDownload(item) {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.outputName;
    document.body.append(a);
    a.click();
    a.remove();
  }

  function clearQueue() {
    for (const item of queue) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    queue = [];
    fileInput.value = '';
    renderQueue();
  }

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', event => addFiles(event.target.files));
  clearQueueBtn.addEventListener('click', clearQueue);
  processBtn.addEventListener('click', processQueue);

  ['dragenter', 'dragover'].forEach(type => {
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(type => {
    dropzone.addEventListener(type, event => {
      event.preventDefault();
      if (type === 'drop') addFiles(event.dataTransfer.files);
      dropzone.classList.remove('dragover');
    });
  });

  multiplierRow.addEventListener('click', event => {
    const card = event.target.closest('[data-mode]');
    if (!card) return;
    selectedMode = card.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(el => {
      const active = el === card;
      el.classList.toggle('active', active);
      if (el.matches('button')) el.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    if (selectedMode === 'custom') customMultiplier.focus();
    const multiplier = getMultiplier();
    modeHint.textContent = selectedMode === 'auto' ? 'Auto preserves detected FPS' : `Output/effective FPS = detected FPS x ${multiplier}`;
  });

  customMultiplier.addEventListener('input', () => {
    selectedMode = 'custom';
    const card = document.querySelector('.custom-card');
    document.querySelectorAll('[data-mode]').forEach(el => el.classList.toggle('active', el === card));
    modeHint.textContent = `Output/effective FPS = detected FPS x ${getMultiplier()}`;
  });

  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navItems.forEach(item => item.classList.toggle('active', item.dataset.nav === visible.target.id));
  }, { threshold: [0.28, 0.5, 0.75] });
  document.querySelectorAll('main > section[id]').forEach(section => observer.observe(section));

  renderQueue();
})();
