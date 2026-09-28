import { describeLimit } from '../shared/format';
import { sampleGradient } from '../shared/gradient';
import type { GradientColors, UsageLimit } from '../shared/types';
import { el } from './dom';

/**
 * One labelled usage bar. The gradient always spans the full track and the
 * fill only reveals the part up to the current percentage, so the visible
 * colors move from green towards red as usage grows.
 */
export class UsageBar {
  readonly element: HTMLElement;
  private readonly percentText: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly track: HTMLElement;
  private readonly remainingText: HTMLElement;
  private readonly resetText: HTMLElement;

  constructor(title: string) {
    this.element = el('div', 'limit');
    const top = el('div', 'limit-top');
    top.append(el('span', 'limit-name', title), (this.percentText = el('span', 'limit-percent gradient-text')));
    this.track = el('div', 'bar');
    this.track.setAttribute('role', 'progressbar');
    this.track.setAttribute('aria-label', title);
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', '100');
    this.fill = el('div', 'bar-fill');
    this.track.append(this.fill);
    const bottom = el('div', 'limit-bottom');
    bottom.append((this.remainingText = el('span', 'limit-remaining')), (this.resetText = el('span', 'limit-reset')));
    this.element.append(top, this.track, bottom);
  }

  /** `placeholder` replaces the reset text when there is no data yet (e.g. "Loading..."). */
  update(limit: UsageLimit | null, colors: GradientColors, now: number, placeholder?: string): void {
    const display = describeLimit(limit, now);
    this.fill.style.setProperty('--pct', `${display.percent}%`);
    this.track.setAttribute('aria-valuenow', String(Math.round(display.percent)));
    this.percentText.textContent = display.percentText;
    this.percentText.style.color = limit === null ? '' : sampleGradient(colors, display.percent);
    this.remainingText.textContent = display.remainingText;
    if (limit === null && placeholder) {
      this.resetText.textContent = placeholder;
    } else {
      this.resetText.textContent = display.resetTimeText
        ? `${display.resetText} · ${display.resetTimeText}`
        : display.resetText;
    }
  }
}
