import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type WidgetApi } from '../shared/ipc';
import type { AppState, Settings } from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: WidgetApi = {
  getState: () => ipcRenderer.invoke(IpcChannels.getState),
  onStateChanged: (listener) => subscribe<AppState>(IpcChannels.stateChanged, listener),
  getSettings: () => ipcRenderer.invoke(IpcChannels.getSettings),
  onSettingsChanged: (listener) => subscribe<Settings>(IpcChannels.settingsChanged, listener),
  updateSettings: (patch) => ipcRenderer.invoke(IpcChannels.updateSettings, patch),
  resetColors: () => ipcRenderer.invoke(IpcChannels.resetColors),
  refreshNow: () => ipcRenderer.invoke(IpcChannels.refreshNow),
  addAccountViaLogin: () => ipcRenderer.invoke(IpcChannels.addAccountViaLogin),
  addAccountWithSessionKey: (sessionKey) => ipcRenderer.invoke(IpcChannels.addAccountWithSessionKey, sessionKey),
  reloginAccount: (accountId) => ipcRenderer.invoke(IpcChannels.reloginAccount, accountId),
  renameAccount: (accountId, label) => ipcRenderer.invoke(IpcChannels.renameAccount, accountId, label),
  removeAccount: (accountId) => ipcRenderer.invoke(IpcChannels.removeAccount, accountId),
  openSettings: () => ipcRenderer.send(IpcChannels.openSettings),
  hideWidget: () => ipcRenderer.send(IpcChannels.hideWidget),
  setWidgetHeight: (height) => ipcRenderer.send(IpcChannels.setWidgetHeight, height),
};

contextBridge.exposeInMainWorld('widgetApi', api);
