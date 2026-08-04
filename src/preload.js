const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('podcastApp', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getHardwareProfile: () => ipcRenderer.invoke('hardware:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testDeepSeek: (apiKey) => ipcRenderer.invoke('deepseek:test', apiKey),
  chooseOutputDirectory: () => ipcRenderer.invoke('dialog:output-directory'),
  inspectLink: (url) => ipcRenderer.invoke('podcast:inspect', url),
  enqueueTask: (payload) => ipcRenderer.invoke('task:enqueue', payload),
  enqueueSummary: (taskId) => ipcRenderer.invoke('task:enqueue-summary', taskId),
  listTasks: () => ipcRenderer.invoke('task:list'),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  pauseTask: (taskId) => ipcRenderer.invoke('task:pause', taskId),
  resumeTask: (taskId) => ipcRenderer.invoke('task:resume', taskId),
  retryTask: (taskId) => ipcRenderer.invoke('task:retry', taskId),
  getKnowledgeStats: () => ipcRenderer.invoke('knowledge:stats'),
  refreshKnowledge: () => ipcRenderer.invoke('knowledge:refresh'),
  askKnowledge: (question) => ipcRenderer.invoke('knowledge:ask', question),
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  onProgress: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('task:progress', handler);
    return () => ipcRenderer.removeListener('task:progress', handler);
  },
  onTaskUpdate: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('task:update', handler);
    return () => ipcRenderer.removeListener('task:update', handler);
  }
});
