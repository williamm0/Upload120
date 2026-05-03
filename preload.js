const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('api', {
  // file & folder
  openFiles:    ()       => ipcRenderer.invoke('dialog:openFiles'),
  openFolder:   ()       => ipcRenderer.invoke('dialog:openFolder'),
  pickVideo:    ()       => ipcRenderer.invoke('dialog:pickVideo'),
  saveAs:       (name)   => ipcRenderer.invoke('dialog:saveAs', name),
  saveFolder:   ()       => ipcRenderer.invoke('dialog:saveFolder'),

  // mp4 ops
  inspectMp4:   (p)      => ipcRenderer.invoke('mp4:inspect', p),
  patchMp4:     (args)   => ipcRenderer.invoke('mp4:patch', args),

  // shell / system
  reveal:       (p)      => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (u)      => ipcRenderer.invoke('shell:openExternal', u),
  openUrl:      (u)      => ipcRenderer.invoke('open:url', u),
  copy:         (text)   => ipcRenderer.invoke('clipboard:write', text),
  notify:       (n)      => ipcRenderer.invoke('app:notify', n),

  // app
  getVersion:   ()       => ipcRenderer.invoke('app:getVersion'),

  // TikTok
  tiktokStatus:    ()       => ipcRenderer.invoke('tiktok:status'),
  tiktokOpenLogin: ()       => ipcRenderer.invoke('tiktok:openLogin'),
  tiktokOpenUpload:()       => ipcRenderer.invoke('tiktok:openUploadPage'),
  tiktokLogout:    ()       => ipcRenderer.invoke('tiktok:logout'),
  tiktokUpload:    (args)   => ipcRenderer.invoke('tiktok:upload', args),
  tiktokFocus:     ()       => ipcRenderer.invoke('tiktok:focus'),
  showInfo:        (args)   => ipcRenderer.invoke('app:showInfo', args),
  onTikTokEvent: (cb) => {
    ipcRenderer.on('tiktok:event', (_e, ev) => cb(ev));
  },

  onMenu: (channel, cb) => {
    const valid = ['menu:openFile', 'menu:openFolder', 'menu:clearQueue', 'menu:showAbout', 'menu:showHelp'];
    if (valid.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => cb(...args));
    }
  },

  // path helpers
  basename:  (p)         => path.basename(p),
  dirname:   (p)         => path.dirname(p),
  joinPath:  (...parts)  => path.join(...parts),
  parsePath: (p)         => path.parse(p),
  platform: process.platform
});
