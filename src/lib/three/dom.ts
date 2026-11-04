/** Tiny DOM helpers used from R3F event handlers (kept out of components so render stays pure). */

export function setCursor(el: HTMLElement | null | undefined, cursor: string) {
  if (el && el.style.cursor !== cursor) el.style.cursor = cursor;
}

/** Positions an absolutely-positioned tooltip next to the pointer, flipping near the right/bottom edges. */
export function placeTooltip(el: HTMLElement | null, container: HTMLElement | null, clientX: number, clientY: number) {
  if (!el || !container) return;
  const r = container.getBoundingClientRect();
  const x = clientX - r.left;
  const y = clientY - r.top;
  const w = el.offsetWidth || 220;
  const h = el.offsetHeight || 80;
  const left = x + 16 + w > r.width ? x - w - 14 : x + 16;
  const top = y + 16 + h > r.height ? y - h - 12 : y + 16;
  el.style.transform = `translate3d(${Math.max(8, left)}px, ${Math.max(8, top)}px, 0)`;
}
