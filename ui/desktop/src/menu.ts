// clampMenuPosition keeps a popup fully on screen: if it would overflow the
// right/bottom edge it flips back by its own size, and it never goes negative.
// Pure so it can be unit-tested without a DOM.
export function clampMenuPosition(
  x: number, y: number,
  menuW: number, menuH: number,
  viewportW: number, viewportH: number,
  margin = 8,
): { left: number; top: number } {
  let left = x;
  let top = y;
  if (left + menuW + margin > viewportW) left = Math.max(margin, viewportW - menuW - margin);
  if (top + menuH + margin > viewportH) top = Math.max(margin, viewportH - menuH - margin);
  return { left: Math.max(margin, left), top: Math.max(margin, top) };
}
