/**
 * PROXIED PICTURES ARE ASKED FOR A FEW AT A TIME, FOR THE WHOLE TAB.
 *
 * A message frame runs no script, so every `<img src>` and every CSS `url()` in it starts at parse
 * and `loading="lazy"` is ignored there. A view that mounts several picture-heavy letters therefore
 * asked `GET /img` for all of them at once: one tab's Screener drew 27 newsletters of 40 pictures,
 * 1,080 requests in six seconds, and the API's database pool filled for everyone. The sanitizer
 * now parks each proxied src in {@link DEFERRED_SRC_ATTR} over a blank, and each inline style or
 * `<style>` sheet with proxied `url()`s in its parked form (those urls as `none`), the live form in
 * {@link DEFERRED_STYLE_ATTR} or {@link DEFERRED_SHEET_ATTR} and its urls in {@link DEFERRED_URLS_ATTR}.
 * This queue hands them out once the frame has loaded, at most {@link PROXIED_IMAGES_IN_FLIGHT} in
 * flight. The frame newest to load goes first, its pictures top to bottom. A CSS url is fetched by
 * a probe `<img>` of the frame's own document, so the live style swapped in once its urls have
 * ended finds them already loaded there and asks for none of them again. A url whose probe did not
 * load (a refusal carries no cache lifetime) is swapped in as `none`, never asked a second time.
 *
 * A picture's end is read off `complete` on a timer rather than from its events: a sandboxed
 * frame without scripts calls no listener in WebKit. A picture whose frame went away (its
 * document has no window any more) or that outstays {@link SLOT_MAX_MS} frees its slot too.
 */

/** Where the sanitizer parks a proxied picture's url until the queue starts it. */
export const DEFERRED_SRC_ATTR = "data-ohmail-src";
/** An inline style with its proxied `url()`s, swapped in once they have loaded. */
export const DEFERRED_STYLE_ATTR = "data-ohmail-style";
/** A `<style>` sheet's text with its proxied `url()`s, swapped in once they have loaded. */
export const DEFERRED_SHEET_ATTR = "data-ohmail-sheet";
/** The proxied urls a parked style or sheet waits for, a JSON array. */
export const DEFERRED_URLS_ATTR = "data-ohmail-css-src";
/** A parked picture that declares no height: it waits flat, as one in flight does, not as a square. */
export const PARK_FLAT_ATTR = "data-ohmail-parkflat";
/** Pictures in flight at once, per tab: what a browser allows one host over HTTP/1.1. */
export const PROXIED_IMAGES_IN_FLIGHT = 6;
const POLL_MS = 50;
/** Past the proxy's own fetch budget: a slot is never held longer than this. */
const SLOT_MAX_MS = 15_000;

export interface ProxiedImageQueue {
  /** Start the parked pictures of a frame's document that has just loaded. */
  admit(doc: Document | null | undefined): void;
  /** How many pictures are being fetched now. */
  inFlight(): number;
}

/** One fetch: `start` begins it and gives the image whose `complete` ends it; `settle` runs at its end. */
interface Task { owner: Element; start(): HTMLImageElement | null; settle(img: HTMLImageElement): void }

const live = (el: Element): boolean => el.isConnected && el.ownerDocument.defaultView !== null;

function urlsOf(el: Element): string[] {
  try {
    const urls: unknown = JSON.parse(el.getAttribute(DEFERRED_URLS_ATTR) ?? "[]");
    return Array.isArray(urls) ? [...new Set(urls.filter((u): u is string => typeof u === "string" && u !== ""))] : [];
  } catch {
    return [];
  }
}

/** Each `failed` url out of a live css text, as the sanitizer wrote it (`url("…")`), as `none`. */
function without(css: string, failed: ReadonlySet<string>): string {
  for (const url of failed) {
    const written = url.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, ""); // MessageBody's `cssString`
    css = css.replaceAll(`url("${written}")`, "none");
  }
  return css;
}

function swapIn(el: Element, failed: ReadonlySet<string> = new Set()): void {
  const style = el.getAttribute(DEFERRED_STYLE_ATTR);
  if (style !== null) el.setAttribute("style", without(style, failed));
  const sheet = el.getAttribute(DEFERRED_SHEET_ATTR);
  if (sheet !== null) el.textContent = without(sheet, failed);
  el.removeAttribute(DEFERRED_STYLE_ATTR);
  el.removeAttribute(DEFERRED_SHEET_ATTR);
  el.removeAttribute(DEFERRED_URLS_ATTR);
}

function tasksOf(doc: Document): Task[] {
  const tasks: Task[] = [];
  for (const el of doc.querySelectorAll(`[${DEFERRED_SRC_ATTR}],[${DEFERRED_URLS_ATTR}]`)) {
    const src = el.tagName === "IMG" ? el.getAttribute(DEFERRED_SRC_ATTR) : null;
    if (src) {
      tasks.push({
        owner: el,
        start: () => {
          el.removeAttribute(DEFERRED_SRC_ATTR);
          el.setAttribute("src", src);
          return el as HTMLImageElement;
        },
        settle: () => el.removeAttribute(PARK_FLAT_ATTR),
      });
    }
    if (!el.hasAttribute(DEFERRED_URLS_ATTR)) continue;
    const urls = urlsOf(el);
    if (urls.length === 0) swapIn(el);
    let left = urls.length;
    const failed = new Set<string>();
    for (const url of urls) {
      tasks.push({
        owner: el,
        start: () => {
          const probe = el.ownerDocument.createElement("img");
          probe.src = url;
          return probe;
        },
        settle: (probe) => {
          left -= 1;
          if (!probe.complete || probe.naturalWidth === 0) failed.add(url);
          if (left === 0) swapIn(el, failed);
        },
      });
    }
  }
  return tasks;
}

export function createProxiedImageQueue(max = PROXIED_IMAGES_IN_FLIGHT): ProxiedImageQueue {
  /** One batch per admitted document, newest first. */
  const waiting: Task[][] = [];
  const flying = new Map<HTMLImageElement, { task: Task; at: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = (): void => {
    const now = Date.now();
    for (const [img, { task, at }] of flying) {
      const gone = !live(task.owner);
      if (img.complete || gone || now - at > SLOT_MAX_MS) {
        flying.delete(img);
        if (!gone) task.settle(img);
      }
    }
    while (flying.size < max && waiting.length > 0) {
      const batch = waiting[0]!;
      const task = batch.shift();
      if (batch.length === 0) waiting.shift();
      if (!task || !live(task.owner)) continue;
      const img = task.start();
      if (img) flying.set(img, { task, at: now });
    }
    if (timer === null && flying.size > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, POLL_MS);
    }
  };

  return {
    admit(doc) {
      const parked = doc ? tasksOf(doc) : [];
      if (parked.length > 0) waiting.unshift(parked);
      pump();
    },
    inFlight: () => flying.size,
  };
}

/** The tab's one queue: every message frame shares the budget. */
export const proxiedImages: ProxiedImageQueue = createProxiedImageQueue();
