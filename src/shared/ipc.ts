import type { ActionResult, AppState, Settings, SettingsPatch } from './types';

export const IpcChannels = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  resetColors: 'settings:reset-colors',
  settingsChanged: 'settings:changed',
  refreshNow: 'usage:refresh',
  addAccountViaLogin: 'accounts:add-via-login',
  addAccountWithSessionKey: 'accounts:add-with-session-key',
  reloginAccount: 'accounts:relogin',
  renameAccount: 'accounts:rename',
  removeAccount: 'accounts:remove',
  openSettings: 'window:open-settings',
  hideWidget: 'window:hide-widget',
  setWidgetHeight: 'window:set-widget-height',
} as const;

/** The API the preload script exposes to the renderer as `window.widgetApi`. */
export interface WidgetApi {
  getState(): Promise<AppState>;
  onStateChanged(listener: (state: AppState) => void): () => void;
  getSettings(): Promise<Settings>;
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  resetColors(): Promise<Settings>;
  refreshNow(): Promise<void>;
  addAccountViaLogin(): Promise<ActionResult>;
  addAccountWithSessionKey(sessionKey: string): Promise<ActionResult>;
  reloginAccount(accountId: string): Promise<ActionResult>;
  renameAccount(accountId: string, label: string): Promise<void>;
  removeAccount(accountId: string): Promise<void>;
  openSettings(): void;
  hideWidget(): void;
  setWidgetHeight(height: number): void;
}
