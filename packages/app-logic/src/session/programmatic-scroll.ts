/**
 * THE ONE DOOR FOR A SCROLL THE APP MAKES ITSELF in the reader — the thread anchor, the reply
 * dock's jump, a framed body's scroll restore. A write stamps the element with the scrollTop it
 * produced, and the stamp stands until the SECOND animation frame after the write: the browser
 * sends that write's `scroll` event in the next frame, before its frame callbacks, however long a
 * task runs in between. A `scroll` landing on the stamped value is never a reading
 * (`reader-seen.ts`). `reader-programmatic-scroll-census` refuses a raw scroll write here.
 */

const stamps = new WeakMap<Element, { top: number; token: number }>();
let tokens = 0;

function stamp(el: Element): void {
  const token = ++tokens;
  stamps.set(el, { top: el.scrollTop, token });
  const clear = (): void => { if (stamps.get(el)?.token === token) stamps.delete(el); };
  const win = el.ownerDocument?.defaultView;
  if (win?.requestAnimationFrame) win.requestAnimationFrame(() => win.requestAnimationFrame(clear));
  else setTimeout(() => setTimeout(clear, 16), 16);
}

/** `el.scrollTop = top`, stamped with the value the browser settled on. */
export function scrollProgrammatically(el: Element, top: number): void {
  el.scrollTop = top;
  stamp(el);
}

/** `el.scrollIntoView(opts)`, every ancestor stamped with where it ended (any of them may move). */
export function scrollIntoViewProgrammatically(el: Element, opts?: ScrollIntoViewOptions): void {
  el.scrollIntoView?.(opts);
  for (let a: Element | null = el.parentElement; a; a = a.parentElement) stamp(a);
}

/**
 * A PERSON'S WHEEL THAT LANDED BESIDE THE SCROLLER — on the column of squares, which stands outside
 * it — handed to it. Not the app's scroll, so never stamped: the wheel is sent on to the scroller,
 * where the reader's rule takes it as the person's gesture, and the scroll follows.
 */
export function scrollByHand(el: Element, dy: number, wheel: { deltaY: number; deltaMode: number }): void {
  el.dispatchEvent(new WheelEvent("wheel", wheel));
  el.scrollTop += dy;
}

/** Is `el` still where the app last put it, within a pixel, inside that write's stamp? */
export function stampLive(el: Element): boolean {
  const s = stamps.get(el);
  return s !== undefined && Math.abs(el.scrollTop - s.top) <= 1;
}
