import type { WindowPosition } from '../shared/types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Minimum visible part of the widget (in px) for a saved position to be reused. */
const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 40;
const DEFAULT_MARGIN = 16;

function visibleArea(rect: Rect, area: Rect): Size {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Returns the saved position when enough of the widget would be visible on one of
 * the displays; otherwise the top-right corner of the primary display.
 */
export function resolveWidgetPosition(
  saved: WindowPosition | null,
  size: Size,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect,
): WindowPosition {
  if (saved) {
    const rect = { ...saved, ...size };
    const fits = workAreas.some((area) => {
      const visible = visibleArea(rect, area);
      return (
        visible.width >= Math.min(MIN_VISIBLE_WIDTH, size.width) &&
        visible.height >= Math.min(MIN_VISIBLE_HEIGHT, size.height)
      );
    });
    if (fits) return { x: saved.x, y: saved.y };
  }
  return {
    x: primaryWorkArea.x + primaryWorkArea.width - size.width - DEFAULT_MARGIN,
    y: primaryWorkArea.y + DEFAULT_MARGIN,
  };
}

/** Moves `rect` so that it lies inside `area` (as far as it fits). */
export function clampRectToArea(rect: Rect, area: Rect): Rect {
  const x = Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width));
  const y = Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height));
  return { ...rect, x, y };
}
