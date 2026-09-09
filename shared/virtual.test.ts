import { describe, expect, it } from "vitest";
import { UNMEASURED_ROWS, visibleRange } from "./virtual";

const range = (extra: Partial<Parameters<typeof visibleRange>[0]> = {}) =>
  visibleRange({ scrollTop: 0, viewportHeight: 200, rowHeight: 20, count: 1000, overscan: 2, ...extra });

describe("visibleRange", () => {
  it("renders a screenful plus the overscan and pads the rest", () => {
    expect(range()).toEqual({ start: 0, end: 15, topPadding: 0, bottomPadding: (1000 - 15) * 20 });
  });

  it("moves the window with the scroll offset", () => {
    expect(range({ scrollTop: 400 })).toEqual({ start: 18, end: 33, topPadding: 360, bottomPadding: (1000 - 33) * 20 });
  });

  it("keeps the last window inside the list", () => {
    const window = range({ scrollTop: 19_900 });
    expect(window.end).toBe(1000);
    expect(window.bottomPadding).toBe(0);
    expect(window.start).toBe(993);
  });

  it("renders everything when the list is short", () => {
    expect(range({ count: 5 })).toEqual({ start: 0, end: 5, topPadding: 0, bottomPadding: 0 });
  });

  it("renders a first batch before the container has been measured", () => {
    expect(range({ viewportHeight: 0 })).toEqual({
      start: 0,
      end: UNMEASURED_ROWS,
      topPadding: 0,
      bottomPadding: (1000 - UNMEASURED_ROWS) * 20,
    });
  });

  it("survives an empty list, a negative offset and a zero row height", () => {
    expect(range({ count: 0 })).toEqual({ start: 0, end: 0, topPadding: 0, bottomPadding: 0 });
    expect(range({ scrollTop: -50 }).start).toBe(0);
    expect(range({ rowHeight: 0 })).toEqual({ start: 0, end: 1000, topPadding: 0, bottomPadding: 0 });
  });
});
