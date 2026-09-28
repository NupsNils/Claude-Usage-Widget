import type { WidgetApi } from '../shared/ipc';

declare global {
  interface Window {
    widgetApi: WidgetApi;
  }
}

export {};
