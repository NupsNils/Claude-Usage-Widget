import { formatPercent } from '../shared/format';
import { gradientCss, sampleGradient } from '../shared/gradient';
import type { AccountStatus, AccountView, ActionResult, AppState, GradientColors, Settings } from '../shared/types';
import { byId, el } from './dom';

const api = window.widgetApi;
const PREVIEW_PERCENTAGES = [15, 50, 85, 100];
const COLOR_SAVE_DELAY_MS = 150;

const STATUS_TEXT: Record<AccountStatus, string> = {
  loading: 'Loading...',
  ok: 'Connected',
  auth_error: 'Signed out',
  error: 'Not updated',
};

// ---------------------------------------------------------------- account actions

const accountMessage = byId('account-message');
let busy = false;

function showMessage(text: string, isError: boolean): void {
  accountMessage.textContent = text;
  accountMessage.classList.toggle('error', isError);
  accountMessage.hidden = text === '';
}

/** Runs one account action at a time and reports its result below the account list. */
async function runAction(action: () => Promise<ActionResult>, successText: string): Promise<ActionResult | null> {
  if (busy) return null;
  busy = true;
  updateBusyState();
  showMessage('', false);
  try {
    const result = await action();
    if (result.status === 'ok') showMessage(successText, false);
    else if (result.status === 'error') showMessage(result.error, true);
    return result;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), true);
    return null;
  } finally {
    busy = false;
    updateBusyState();
  }
}

class AccountRow {
  readonly element: HTMLLIElement;
  private readonly labelInput: HTMLInputElement;
  private readonly meta: HTMLElement;
  readonly loginButton: HTMLButtonElement;
  readonly removeButton: HTMLButtonElement;
  private accountId: string;

  constructor(view: AccountView) {
    this.accountId = view.id;
    this.element = el('li', 'account-row');
    const info = el('div', 'account-info');
    this.labelInput = el('input', 'text-input');
    this.labelInput.type = 'text';
    this.labelInput.maxLength = 60;
    this.labelInput.setAttribute('aria-label', 'Display name');
    this.labelInput.addEventListener('change', () => {
      void api.renameAccount(this.accountId, this.labelInput.value);
    });
    this.meta = el('div', 'account-meta');
    info.append(this.labelInput, this.meta);

    const actions = el('div', 'account-actions');
    this.loginButton = el('button', 'button', 'Log in again');
    this.loginButton.type = 'button';
    this.loginButton.addEventListener('click', () => {
      void runAction(() => api.reloginAccount(this.accountId), 'Signed in again.');
    });
    this.removeButton = el('button', 'button danger', 'Remove');
    this.removeButton.type = 'button';
    this.removeButton.addEventListener('click', () => {
      void api.removeAccount(this.accountId);
    });
    actions.append(this.loginButton, this.removeButton);
    this.element.append(info, actions);
  }

  update(view: AccountView): void {
    this.accountId = view.id;
    this.labelInput.placeholder = view.email;
    // Do not overwrite what the user is typing.
    if (document.activeElement !== this.labelInput) this.labelInput.value = view.customLabel ?? '';

    const status = el('span', `status-${view.status}`, STATUS_TEXT[view.status]);
    const details = [view.email, view.organizationName].filter((part): part is string => Boolean(part)).join(' · ');
    this.meta.replaceChildren(`${details} · `, status);
    this.meta.title = view.errorMessage ?? '';
  }
}

const accountList = byId('account-list');
const noAccounts = byId('no-accounts');
const addLoginButton = byId<HTMLButtonElement>('add-login-button');
const sessionKeyInput = byId<HTMLInputElement>('session-key-input');
const sessionKeyButton = byId<HTMLButtonElement>('session-key-button');
const rows = new Map<string, AccountRow>();

function updateBusyState(): void {
  addLoginButton.disabled = busy;
  sessionKeyButton.disabled = busy;
  for (const row of rows.values()) row.loginButton.disabled = busy;
}

function renderAccounts(state: AppState): void {
  const seen = new Set<string>();
  state.accounts.forEach((view, index) => {
    seen.add(view.id);
    let row = rows.get(view.id);
    if (!row) {
      row = new AccountRow(view);
      rows.set(view.id, row);
    }
    row.update(view);
    if (accountList.children[index] !== row.element) {
      accountList.insertBefore(row.element, accountList.children[index] ?? null);
    }
  });
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.element.remove();
      rows.delete(id);
    }
  }
  noAccounts.hidden = state.accounts.length > 0;
  updateBusyState();
}

addLoginButton.addEventListener('click', () => {
  void runAction(() => api.addAccountViaLogin(), 'Account added.');
});

async function addWithSessionKey(): Promise<void> {
  const value = sessionKeyInput.value;
  if (value.trim() === '') return;
  const result = await runAction(() => api.addAccountWithSessionKey(value), 'Account added.');
  if (result?.status === 'ok') sessionKeyInput.value = '';
}

sessionKeyButton.addEventListener('click', () => void addWithSessionKey());
sessionKeyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void addWithSessionKey();
});

// ---------------------------------------------------------------- general settings

const refreshInterval = byId<HTMLInputElement>('refresh-interval');
const alwaysOnTop = byId<HTMLInputElement>('always-on-top');
const launchAtStartup = byId<HTMLInputElement>('launch-at-startup');
const colorInputs: Record<keyof GradientColors, HTMLInputElement> = {
  low: byId<HTMLInputElement>('color-low'),
  mid: byId<HTMLInputElement>('color-mid'),
  high: byId<HTMLInputElement>('color-high'),
};
const preview = byId('color-preview');

function renderPreview(colors: GradientColors): void {
  document.documentElement.style.setProperty('--bar-gradient', gradientCss(colors));
  preview.replaceChildren(
    ...PREVIEW_PERCENTAGES.flatMap((percent) => {
      const label = el('span', 'preview-percent gradient-text', formatPercent(percent));
      label.style.color = sampleGradient(colors, percent);
      const bar = el('div', 'bar');
      const fill = el('div', 'bar-fill');
      fill.style.setProperty('--pct', `${percent}%`);
      bar.append(fill);
      return [label, bar];
    }),
  );
}

function renderSettings(settings: Settings): void {
  if (document.activeElement !== refreshInterval) refreshInterval.value = String(settings.refreshIntervalSeconds);
  alwaysOnTop.checked = settings.alwaysOnTop;
  launchAtStartup.checked = settings.launchAtStartup;
  // While a color picker is open, the echo of an earlier save must not reset it.
  const pickingColor = Object.values(colorInputs).some((input) => document.activeElement === input);
  if (pickingColor) return;
  for (const key of Object.keys(colorInputs) as Array<keyof GradientColors>) {
    if (colorInputs[key].value !== settings.colors[key]) colorInputs[key].value = settings.colors[key];
  }
  renderPreview(settings.colors);
}

refreshInterval.addEventListener('change', () => {
  void api.updateSettings({ refreshIntervalSeconds: Number(refreshInterval.value) }).then((settings) => {
    refreshInterval.value = String(settings.refreshIntervalSeconds);
  });
});
alwaysOnTop.addEventListener('change', () => void api.updateSettings({ alwaysOnTop: alwaysOnTop.checked }));
launchAtStartup.addEventListener('change', () => void api.updateSettings({ launchAtStartup: launchAtStartup.checked }));

let colorTimer: ReturnType<typeof setTimeout> | undefined;
for (const key of Object.keys(colorInputs) as Array<keyof GradientColors>) {
  colorInputs[key].addEventListener('input', () => {
    const colors = {
      low: colorInputs.low.value,
      mid: colorInputs.mid.value,
      high: colorInputs.high.value,
    };
    renderPreview(colors);
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => void api.updateSettings({ colors }), COLOR_SAVE_DELAY_MS);
  });
}
byId('reset-colors-button').addEventListener('click', () => {
  clearTimeout(colorTimer);
  void api.resetColors();
});

// ---------------------------------------------------------------- startup

api.onStateChanged(renderAccounts);
api.onSettingsChanged(renderSettings);
void Promise.all([api.getSettings(), api.getState()]).then(([settings, state]) => {
  renderSettings(settings);
  renderAccounts(state);
});
