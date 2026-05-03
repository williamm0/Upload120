const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme, Menu, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { patchMp4Buffer, inspectMp4 } = require('./src/patcher');

let mainWindow;
let tikTokWindow = null;

const TIKTOK_BASE   = 'https://www.tiktok.com';
const TIKTOK_UPLOAD = `${TIKTOK_BASE}/tiktokstudio/upload?from=upload`;
const TIKTOK_LOGIN  = `${TIKTOK_BASE}/login?redirect_url=${encodeURIComponent(TIKTOK_UPLOAD)}`;
const FIRST_RUN_FLAG = path.join(app.getPath('userData'), 'upload120-first-run.json');

function tikTokSession() {
  return session.fromPartition('persist:tiktok');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 880,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#0a0b10',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Video…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu:openFile') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow.webContents.send('menu:openFolder') },
        { type: 'separator' },
        { label: 'Clear Queue', accelerator: 'CmdOrCtrl+K', click: () => mainWindow.webContents.send('menu:clearQueue') }
      ]
    },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'About Upload120', click: () => mainWindow.webContents.send('menu:showAbout') },
        { label: 'How It Works', click: () => mainWindow.webContents.send('menu:showHelp') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function markFirstRunComplete() {
  try {
    if (!fs.existsSync(FIRST_RUN_FLAG)) {
      fs.writeFileSync(FIRST_RUN_FLAG, JSON.stringify({ seen: true, at: new Date().toISOString() }));
    }
  } catch {}
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  nativeTheme.themeSource = 'dark';
  markFirstRunComplete();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── File / folder pickers ────────────────────────────────────────────────

ipcMain.handle('dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select videos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a folder of videos', properties: ['openDirectory']
  });
  if (r.canceled || r.filePaths.length === 0) return [];
  try {
    return fs.readdirSync(r.filePaths[0])
      .filter(e => /\.(mp4|mov|m4v)$/i.test(e))
      .map(e => path.join(r.filePaths[0], e));
  } catch { return []; }
});

ipcMain.handle('dialog:saveAs', async (_e, suggestedName) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save patched video', defaultPath: suggestedName,
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:saveFolder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickVideo', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose video to post', properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v'] }]
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const p = r.filePaths[0];
  try {
    const stat = fs.statSync(p);
    return { path: p, size: stat.size };
  } catch { return { path: p, size: 0 }; }
});

// ─── MP4 ops ──────────────────────────────────────────────────────────────

ipcMain.handle('mp4:inspect', async (_e, filePath) => {
  try {
    const buf = await fs.promises.readFile(filePath);
    const meta = inspectMp4(buf);
    const stat = await fs.promises.stat(filePath);
    return { ok: true, filePath, size: stat.size, ...meta };
  } catch (err) {
    return { ok: false, error: err.message, filePath };
  }
});

ipcMain.handle('mp4:patch', async (_e, { input, output, divider, fps }) => {
  try {
    const buf = await fs.promises.readFile(input);
    const result = patchMp4Buffer(buf, divider);
    await fs.promises.writeFile(output, result.buffer);
    return {
      ok: true, input, output,
      mvhd: result.mvhdCount, mdhd: result.mdhdCount,
      originalFps: fps, effectiveFps: fps * divider
    };
  } catch (err) {
    return { ok: false, error: err.message, input };
  }
});

// ─── System helpers ───────────────────────────────────────────────────────

ipcMain.handle('clipboard:write', async (_e, text) => {
  try { clipboard.writeText(typeof text === 'string' ? text : ''); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('shell:reveal', async (_e, p) => {
  if (p && typeof p === 'string') shell.showItemInFolder(p);
});
ipcMain.handle('shell:openExternal', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle('open:url', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle('app:notify', async (_e, { title, body } = {}) => {
  if (Notification.isSupported()) {
    new Notification({ title: title || 'Upload120', body: body || '', silent: false }).show();
  }
});
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('app:showInfo', async (_e, { title, message, detail } = {}) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: title || app.name,
    message: message || '',
    detail: detail || ''
  });
  return { ok: true };
});

// ═══ TikTok integration ════════════════════════════════════════════════════

function emit(stage, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tiktok:event', { stage, ...payload });
  }
}

async function tikTokIsLoggedIn() {
  try {
    const cookies = await tikTokSession().cookies.get({ url: TIKTOK_BASE });
    const has = (n) => cookies.some(c => c.name === n && c.value && c.value.length > 5);
    if (has('sessionid_ss') || has('sessionid') || has('passport_csrf_token')) return true;
  } catch {}

  try {
    const probe = ensureTikTokWindow({ url: TIKTOK_UPLOAD, show: false });
    await waitForLoad(probe.webContents);
    const onLogin = await evalInPage(probe.webContents, () => /\/login/i.test(location.href));
    return !onLogin;
  } catch {
    return false;
  }
}

async function showLoginReadyPopup() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: app.name,
    message: "You're signed in.",
    detail: 'It is okay to close the TikTok window now.'
  });
}

function ensureTikTokWindow({ url, show = false } = {}) {
  if (tikTokWindow && !tikTokWindow.isDestroyed()) {
    if (show) { tikTokWindow.show(); tikTokWindow.focus(); }
    else      { tikTokWindow.hide(); }
    if (url) tikTokWindow.loadURL(url);
    return tikTokWindow;
  }
  tikTokWindow = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 1024,
    minHeight: 720,
    title: 'TikTok',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show,
    webPreferences: {
      session: tikTokSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });
  tikTokWindow.on('closed', () => { tikTokWindow = null; });
  tikTokWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  tikTokWindow.loadURL(url || TIKTOK_LOGIN);
  return tikTokWindow;
}

function waitForLoad(wc, timeout = 60000) {
  return new Promise((resolve, reject) => {
    if (!wc.isLoading()) return resolve();
    const t = setTimeout(() => {
      wc.removeListener('did-finish-load', onLoad);
      wc.removeListener('did-fail-load', onFail);
      reject(new Error('Timed out loading page'));
    }, timeout);
    const onLoad = () => { clearTimeout(t); cleanup(); resolve(); };
    const onFail = (_e, code, desc) => {
      if (code === -3) return;
      clearTimeout(t); cleanup(); reject(new Error(`Load failed: ${desc} (${code})`));
    };
    const cleanup = () => {
      wc.removeListener('did-finish-load', onLoad);
      wc.removeListener('did-fail-load', onFail);
    };
    wc.once('did-finish-load', onLoad);
    wc.once('did-fail-load', onFail);
  });
}

async function evalInPage(wc, fn, ...args) {
  const code = `(${fn.toString()}).apply(null, ${JSON.stringify(args)});`;
  return wc.executeJavaScript(code, true);
}

async function waitForSelector(wc, selectors, { timeout = 30000, interval = 300 } = {}) {
  const start = Date.now();
  const list = Array.isArray(selectors) ? selectors : [selectors];
  while (Date.now() - start < timeout) {
    const hit = await evalInPage(wc, (sels) => {
      for (const s of sels) {
        try { if (document.querySelector(s)) return s; } catch {}
      }
      return null;
    }, list);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out: ${list.join(' | ')}`);
}

async function setFileInput(wc, filePath) {
  let attached = false;
  try {
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attached = true; }
    await wc.debugger.sendCommand('DOM.enable');
    const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const candidates = ['input[type="file"][accept*="video"]', 'input[type="file"]'];
    let nodeId = 0;
    for (const sel of candidates) {
      const r = await wc.debugger.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId, selector: sel
      });
      if (r && r.nodeId) { nodeId = r.nodeId; break; }
    }
    if (!nodeId) throw new Error('No file input on page');
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId });
  } finally {
    if (attached && wc.debugger.isAttached()) {
      try { wc.debugger.detach(); } catch {}
    }
  }
}

async function injectCaption(wc, caption) {
  if (!caption) return false;
  return await evalInPage(wc, (text) => {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    async function run() {
      const candidates = [
        '[data-contents="true"] [contenteditable="true"]',
        '.public-DraftEditor-content',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]'
      ];
      let el = null;
      for (let i = 0; i < 24 && !el; i++) {
        for (const s of candidates) {
          const e = document.querySelector(s);
          if (e) { el = e; break; }
        }
        if (!el) await sleep(250);
      }
      if (!el) return false;
      el.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
      } catch {}
      try {
        document.execCommand('insertText', false, text);
      } catch {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return true;
    }
    return run();
  }, caption);
}

async function setOptions(wc, options) {
  return await evalInPage(wc, (opts) => {
    function clickByText(text) {
      const candidates = Array.from(document.querySelectorAll('button, label, span, div'));
      const hit = candidates.find(el => (el.textContent || '').trim() === text);
      if (hit) { hit.click(); return true; }
      return false;
    }
    function setSwitchByLabel(labelText, on) {
      const labels = Array.from(document.querySelectorAll('label, span, div, button'));
      const labelEl = labels.find(el => (el.textContent || '').trim().toLowerCase().includes(labelText.toLowerCase()));
      if (!labelEl) return false;
      const sw = labelEl.querySelector('[role="switch"], button[aria-checked]') ||
                 labelEl.parentElement?.querySelector('[role="switch"], button[aria-checked]') ||
                 labelEl.closest('div')?.querySelector('[role="switch"], button[aria-checked]');
      if (!sw) return false;
      const checked = sw.getAttribute('aria-checked') === 'true';
      if (checked !== !!on) sw.click();
      return true;
    }
    const r = {};
    if (opts.privacy) {
      r.privacy = clickByText({ public: 'Everyone', friends: 'Friends', private: 'Only you' }[opts.privacy] || 'Everyone');
    }
    if (typeof opts.allowComments === 'boolean') r.comments = setSwitchByLabel('Comment', opts.allowComments);
    if (typeof opts.allowDuet === 'boolean')      r.duet     = setSwitchByLabel('Duet', opts.allowDuet);
    if (typeof opts.allowStitch === 'boolean')    r.stitch   = setSwitchByLabel('Stitch', opts.allowStitch);
    return r;
  }, options || {});
}

async function clickPostButton(wc) {
  return await evalInPage(wc, () => {
    function findButton() {
      const explicit = document.querySelector('[data-e2e="post_video_button"], [data-e2e="post-button"], [data-e2e*="post-button"]');
      if (explicit && !explicit.disabled) return explicit;
      const all = Array.from(document.querySelectorAll('button'));
      const exact = all.find(b => /^post$/i.test((b.textContent || '').trim()) && !b.disabled);
      if (exact) return exact;
      return null;
    }
    const btn = findButton();
    if (!btn) return false;
    btn.scrollIntoView();
    btn.click();
    return true;
  });
}

async function waitForPosted(wc, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await evalInPage(wc, () => {
      // Detect success: URL changed, "posted" message, or upload UI gone
      const url = location.href;
      if (/\/manage|\/profile|\/foryou|tiktokstudio\/content/.test(url)) return { done: true, reason: 'navigated' };
      // Look for success toast
      const text = document.body ? document.body.innerText : '';
      if (/your video has been posted|posted successfully|video uploaded/i.test(text)) return { done: true, reason: 'message' };
      // Look for editor still present (upload area gone)  -  if no caption editor, it's likely done
      const editor = document.querySelector('[data-contents="true"] [contenteditable="true"], .public-DraftEditor-content');
      const fileInput = document.querySelector('input[type="file"][accept*="video"], input[type="file"]');
      // Heuristic: if neither editor nor file input is present after we clicked, posting is complete
      if (!editor && !fileInput) return { done: true, reason: 'editor-gone' };
      return { done: false };
    });
    if (result && result.done) return result;
    await new Promise(r => setTimeout(r, 600));
  }
  return { done: false, reason: 'timeout' };
}

async function performTikTokUpload({ filePath, caption, options, autoPost = true }) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
  if (!(await tikTokIsLoggedIn())) {
    emit('needs-login');
    ensureTikTokWindow({ url: TIKTOK_LOGIN, show: false });
    return { ok: false, needsLogin: true };
  }

  emit('opening');
  const win = ensureTikTokWindow({ url: TIKTOK_UPLOAD, show: false });
  const wc = win.webContents;
  await waitForLoad(wc);
  emit('page-loaded');

  // Re-check after load: some session checks happen client-side
  const isLogin = await evalInPage(wc, () => location.pathname.includes('/login'));
  if (isLogin) {
    emit('needs-login');
    return { ok: false, needsLogin: true };
  }

  emit('waiting-file-input');
  await waitForSelector(wc, ['input[type="file"][accept*="video"]', 'input[type="file"]'], { timeout: 45000 });

  emit('attaching-file');
  await setFileInput(wc, filePath);

  emit('waiting-editor');
  await waitForSelector(wc, [
    '[data-contents="true"] [contenteditable="true"]',
    '.public-DraftEditor-content',
    'div[role="textbox"][contenteditable="true"]'
  ], { timeout: 120000 });

  if (caption && caption.trim().length > 0) {
    emit('inserting-caption');
    await injectCaption(wc, caption);
    emit('caption-inserted');
  }

  if (options) {
    emit('setting-options');
    try { await setOptions(wc, options); } catch {}
  }

  if (!autoPost) {
    emit('ready');
    return { ok: true, autoPosted: false };
  }

  // Wait briefly for the Post button to enable (TikTok validates upload first)
  emit('waiting-post-ready');
  let clickedAt = 0;
  const clickStart = Date.now();
  while (Date.now() - clickStart < 120000) {
    const ok = await clickPostButton(wc);
    if (ok) { clickedAt = Date.now(); break; }
    await new Promise(r => setTimeout(r, 700));
  }
  if (!clickedAt) {
    emit('post-button-failed');
    return { ok: false, error: 'Could not click Post button  -  please post manually in the TikTok window.' };
  }

  emit('posting');
  const result = await waitForPosted(wc, 120000);
  if (result && result.done) {
    emit('posted');
    // Close hidden window after a short delay
    setTimeout(() => {
      if (tikTokWindow && !tikTokWindow.isDestroyed()) {
        try { tikTokWindow.close(); } catch {}
        tikTokWindow = null;
      }
    }, 2500);
    return { ok: true, autoPosted: true };
  } else {
    emit('post-pending');
    return { ok: true, autoPosted: false, pending: true };
  }
}

ipcMain.handle('tiktok:status', async () => ({ loggedIn: await tikTokIsLoggedIn() }));

let waitingForLoginPopup = false;

ipcMain.handle('tiktok:openLogin', async () => {
  waitingForLoginPopup = true;
  ensureTikTokWindow({ url: TIKTOK_LOGIN, show: false });
  return { ok: true };
});

ipcMain.handle('tiktok:openUploadPage', async () => {
  ensureTikTokWindow({ url: TIKTOK_UPLOAD, show: false });
  return { ok: true };
});

ipcMain.handle('tiktok:logout', async () => {
  try {
    waitingForLoginPopup = false;
    const s = tikTokSession();
    await s.clearStorageData();
    if (tikTokWindow && !tikTokWindow.isDestroyed()) {
      tikTokWindow.close();
      tikTokWindow = null;
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('tiktok:upload', async (_e, args) => {
  try {
    const result = await performTikTokUpload(args || {});
    if (result && result.ok && waitingForLoginPopup) {
      waitingForLoginPopup = false;
      await showLoginReadyPopup();
    }
    return result;
  }
  catch (err) {
    emit('error', { message: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('tiktok:focus', async () => {
  if (tikTokWindow && !tikTokWindow.isDestroyed()) {
    tikTokWindow.hide();
    return { ok: true };
  }
  return { ok: false };
});
