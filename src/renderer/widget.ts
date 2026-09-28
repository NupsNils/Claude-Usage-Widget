import { formatClockTime } from '../shared/format';
import { DEFAULT_COLORS, gradientCss } from '../shared/gradient';
import type { AccountView, AppState, GradientColors } from '../shared/types';
import { byId, el } from './dom';
import { UsageBar } from './usageBar';

const api = window.widgetApi;
const TICK_MS = 15_000;

class AccountCard {
  readonly element: HTMLElement;
  private readonly label: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly message: HTMLElement;
  private readonly messageText: HTMLElement;
  private readonly loginButton: HTMLButtonElement;
  private readonly session = new UsageBar('Current session');
  private readonly weekly = new UsageBar('Weekly limit');
  private accountId: string;

  constructor(view: AccountView) {
    this.accountId = view.id;
    this.element = el('section', 'account');
    const header = el('div', 'account-header');
    header.append((this.label = el('span', 'account-label')), (this.badge = el('span', 'account-badge')));
    this.message = el('div', 'account-message');
    this.messageText = el('span', 'account-message-text');
    this.loginButton = el('button', 'link-button', 'Log in again');
    this.loginButton.type = 'button';
    this.loginButton.addEventListener('click', () => {
      this.loginButton.disabled = true;
      void api.reloginAccount(this.accountId).finally(() => {
        this.loginButton.disabled = false;
      });
    });
    this.message.append(this.messageText, this.loginButton);
    this.element.append(header, this.message, this.session.element, this.weekly.element);
  }

  update(view: AccountView, colors: GradientColors, now: number): void {
    this.accountId = view.id;
    this.label.textContent = view.label;
    this.label.title = view.organizationName ? `${view.email} (${view.organizationName})` : view.email;

    const badge = view.status === 'auth_error' ? 'Signed out' : view.status === 'error' ? 'Not updated' : '';
    this.badge.textContent = badge;
    this.badge.hidden = badge === '';
    this.badge.dataset.status = view.status;

    const showMessage = view.status === 'auth_error' || view.status === 'error';
    this.message.hidden = !showMessage;
    this.messageText.textContent = showMessage ? (view.errorMessage ?? '') : '';
    this.loginButton.hidden = view.status !== 'auth_error';

    const placeholder = view.status === 'loading' ? 'Loading...' : undefined;
    this.session.update(view.usage?.session ?? null, colors, now, placeholder);
    this.weekly.update(view.usage?.weekly ?? null, colors, now, placeholder);
  }
}

const accountsContainer = byId('accounts');
const emptyState = byId('empty');
const footer = byId('footer');
const refreshButton = byId<HTMLButtonElement>('refresh-button');
const cards = new Map<string, AccountCard>();

let state: AppState = { accounts: [], refreshing: false };
let colors: GradientColors = { ...DEFAULT_COLORS };

function render(): void {
  const now = Date.now();
  const seen = new Set<string>();
  state.accounts.forEach((view, index) => {
    seen.add(view.id);
    let card = cards.get(view.id);
    if (!card) {
      card = new AccountCard(view);
      cards.set(view.id, card);
      resizeObserver.observe(card.element);
    }
    card.update(view, colors, now);
    if (accountsContainer.children[index] !== card.element) {
      accountsContainer.insertBefore(card.element, accountsContainer.children[index] ?? null);
    }
  });
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      resizeObserver.unobserve(card.element);
      card.element.remove();
      cards.delete(id);
    }
  }

  emptyState.hidden = state.accounts.length > 0;
  accountsContainer.hidden = state.accounts.length === 0;
  refreshButton.classList.toggle('spinning', state.refreshing);
  refreshButton.disabled = state.accounts.length === 0;

  const fetchedTimes = state.accounts.flatMap((view) => (view.usage ? [view.usage.fetchedAt] : []));
  if (state.refreshing) {
    footer.textContent = 'Refreshing...';
  } else if (fetchedTimes.length > 0) {
    footer.textContent = `Updated ${formatClockTime(Math.max(...fetchedTimes))}`;
  } else {
    footer.textContent = '';
  }
  footer.hidden = footer.textContent === '';
  reportHeight();
}

function applyColors(next: GradientColors): void {
  colors = next;
  document.documentElement.style.setProperty('--bar-gradient', gradientCss(colors));
}

byId('refresh-button').addEventListener('click', () => void api.refreshNow());
byId('settings-button').addEventListener('click', () => api.openSettings());
byId('hide-button').addEventListener('click', () => api.hideWidget());
byId<HTMLButtonElement>('add-account-button').addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  void api.addAccountViaLogin().finally(() => {
    button.disabled = false;
  });
});

api.onStateChanged((next) => {
  state = next;
  render();
});
api.onSettingsChanged((settings) => {
  applyColors(settings.colors);
  render();
});

const widget = byId('widget');
let reportedHeight = 0;

/** Height the widget needs to show everything, including the part of the account list that is scrolled away. */
function reportHeight(): void {
  const hiddenByScrolling = accountsContainer.hidden ? 0 : accountsContainer.scrollHeight - accountsContainer.clientHeight;
  const height = Math.ceil(widget.getBoundingClientRect().height + hiddenByScrolling);
  if (height !== reportedHeight) {
    reportedHeight = height;
    api.setWidgetHeight(height);
  }
}

const resizeObserver = new ResizeObserver(reportHeight);
resizeObserver.observe(widget);
resizeObserver.observe(accountsContainer);

setInterval(render, TICK_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});

void Promise.all([api.getSettings(), api.getState()]).then(([settings, initialState]) => {
  applyColors(settings.colors);
  state = initialState;
  render();
});
