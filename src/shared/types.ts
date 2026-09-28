/** Colors of the usage bar gradient, as lowercase `#rrggbb` hex strings. */
export interface GradientColors {
  low: string;
  mid: string;
  high: string;
}

export interface WindowPosition {
  x: number;
  y: number;
}

export interface Settings {
  refreshIntervalSeconds: number;
  alwaysOnTop: boolean;
  launchAtStartup: boolean;
  colors: GradientColors;
  widgetPosition: WindowPosition | null;
}

/** The subset of settings the settings window is allowed to change. */
export type SettingsPatch = Partial<
  Pick<Settings, 'refreshIntervalSeconds' | 'alwaysOnTop' | 'launchAtStartup'>
> & {
  colors?: Partial<GradientColors>;
};

export interface UsageLimit {
  /** Share of the limit that has been used, in percent (0-100). */
  utilization: number;
  /** When the current window resets (epoch milliseconds), or null when no window is active. */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  /** The rolling 5-hour session limit. Null when the API did not report it. */
  session: UsageLimit | null;
  /** The weekly limit. Null when the API did not report it. */
  weekly: UsageLimit | null;
  /** When the snapshot was fetched (epoch milliseconds). */
  fetchedAt: number;
}

export type AccountStatus = 'loading' | 'ok' | 'auth_error' | 'error';

export interface AccountView {
  id: string;
  /** Name shown in the widget: the custom label, or the email address. */
  label: string;
  email: string;
  customLabel: string | null;
  organizationName: string | null;
  status: AccountStatus;
  errorMessage: string | null;
  /** Last successfully fetched usage. Kept while a later refresh fails. */
  usage: UsageSnapshot | null;
}

export interface AppState {
  accounts: AccountView[];
  refreshing: boolean;
}

export type ActionResult =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'error'; error: string };
