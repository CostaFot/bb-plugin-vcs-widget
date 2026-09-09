// Fixed-height row windowing, so a log of thousands of commits renders a
// screenful of DOM nodes. Pure arithmetic: the panel supplies the scroll
// offset and the viewport height it measured, and renders the returned slice
// between two spacer divs.

export interface VirtualWindow {
  /** First row to render (inclusive). */
  start: number;
  /** Last row to render (exclusive). */
  end: number;
  /** Pixels of spacer above the rendered slice. */
  topPadding: number;
  /** Pixels of spacer below it. */
  bottomPadding: number;
}

export interface VirtualInput {
  scrollTop: number;
  /** 0 before the container has been measured. */
  viewportHeight: number;
  rowHeight: number;
  count: number;
  /** Rows kept on either side of the viewport so scrolling does not flash. */
  overscan?: number;
}

/** Rows rendered before the viewport has been measured, so the first paint has content. */
export const UNMEASURED_ROWS = 40;

export function visibleRange({ scrollTop, viewportHeight, rowHeight, count, overscan = 8 }: VirtualInput): VirtualWindow {
  const total = Math.max(0, Math.trunc(count));
  if (total === 0 || rowHeight <= 0) return { start: 0, end: total, topPadding: 0, bottomPadding: 0 };
  const window = (start: number, end: number): VirtualWindow => ({
    start,
    end,
    topPadding: start * rowHeight,
    bottomPadding: (total - end) * rowHeight,
  });
  if (viewportHeight <= 0) return window(0, Math.min(total, UNMEASURED_ROWS));
  const offset = Math.max(0, scrollTop);
  const first = Math.floor(offset / rowHeight) - overscan;
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 1;
  const start = Math.max(0, Math.min(first, total));
  return window(start, Math.min(total, start + visible));
}
