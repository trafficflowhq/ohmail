/**
 * A PRESS IN A FRAMED LETTER HANDS THE KEYS BACK. The press moves the focus into the letter's own
 * document, and the app's keys (j, k, Escape, g o) are read on the app's document: WebKit runs no
 * listener in a frame sandboxed without scripts, so nothing can forward them from inside. While the
 * letter holds the focus this looks at it on a short timer; once the press is over the focus goes
 * back to the app, unless the letter holds a link reached with Tab. The timer runs only while a
 * letter holds the focus.
 *
 * A selection stays in the letter's document after the focus leaves it, so copy and select-all are
 * run from the app's side on the letter last pressed (until a press in the app): mod+c while the
 * app's own selection is empty copies the letter's, and mod+a with the focus at the page root
 * selects the whole letter. The keys stay with the app throughout.
 */

const FRAME = "iframe.mb-frame";
/** How often the letter is looked at while it holds the focus and the window is in front. */
export const LETTER_FOCUS_POLL_MS = 100;
/** And while the window is not in front: no focus is taken back then, so slowly. */
const AWAY_POLL_MS = 1000;

const focusedFrame = (doc: Document): HTMLIFrameElement | null => {
  const a = doc.activeElement;
  return a instanceof HTMLIFrameElement && a.matches(FRAME) && a.isConnected ? a : null;
};

/** Does the letter still want the keys: a press under way, or a link reached with Tab. */
export function letterKeepsFocus(frame: HTMLIFrameElement): boolean {
  const inner = frame.contentDocument;
  if (!inner) return false;
  try {
    // The root is `:active` while any press in the document is under way.
    if (inner.documentElement?.matches(":active")) return true;
  } catch { /* an engine without `:active` in selectors */ }
  const el = inner.activeElement;
  if (el && el !== inner.body && el !== inner.documentElement) {
    try {
      return el.matches(":focus-visible");
    } catch {
      return true;
    }
  }
  return false;
}

/** Watch `win` for a letter taking the focus; returns the stop. */
export function watchLetterFocus(win: Window, every = LETTER_FOCUS_POLL_MS): () => void {
  const doc = win.document;
  let timer: number | null = null;
  /** The letter last pressed, until a press in the app. */
  let last: HTMLIFrameElement | null = null;
  const look = (): void => {
    timer = null;
    const frame = focusedFrame(doc);
    if (!frame) return;
    last = frame;
    if (!doc.hasFocus()) {
      timer = win.setTimeout(look, AWAY_POLL_MS);
      return;
    }
    if (letterKeepsFocus(frame)) {
      timer = win.setTimeout(look, every);
      return;
    }
    frame.blur();
    win.focus();
  };
  const onBlur = (): void => {
    if (timer === null && focusedFrame(doc)) timer = win.setTimeout(look, every);
  };
  const onPress = (): void => {
    last = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key !== "c" && key !== "a") return;
    const inner = last?.isConnected ? last.contentDocument : null;
    if (!last || !inner?.body || focusedFrame(doc)) return;
    const a = doc.activeElement;
    if (key === "c") {
      const own = doc.getSelection();
      const editable = a instanceof HTMLElement && (a.isContentEditable || a.matches("input, textarea, select"));
      if (editable || (own && !own.isCollapsed) || (inner.getSelection()?.isCollapsed ?? true)) return;
      // Run on the letter's document: the key's own copy runs on the app's, whose selection is empty.
      if (inner.execCommand("copy")) e.preventDefault();
      else last.focus();
      return;
    }
    if (a && a !== doc.body && a !== doc.documentElement) return;
    e.preventDefault();
    inner.getSelection()?.selectAllChildren(inner.body);
  };
  win.addEventListener("blur", onBlur);
  win.addEventListener("keydown", onKey, true);
  doc.addEventListener("mousedown", onPress, true);
  return () => {
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("mousedown", onPress, true);
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  };
}

/** One watcher per window, however many letters are mounted. */
const watchers = new WeakMap<Window, { count: number; stop: () => void }>();

export function holdLetterFocusWatch(win: Window): () => void {
  const held = watchers.get(win) ?? { count: 0, stop: watchLetterFocus(win) };
  held.count += 1;
  watchers.set(win, held);
  return () => {
    held.count -= 1;
    if (held.count === 0) {
      held.stop();
      watchers.delete(win);
    }
  };
}
