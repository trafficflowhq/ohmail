/* The page of `thread-read-browser.test.ts`: the real thread-read adapter and rule over a laid-out
 * reader, in a real engine. Two rigs. `framed`: one unread designed letter in the real `MessageBody`
 * (its frame, its measure, its proxied pictures), opened and entered at once; with `away` the person
 * scrolls into its middle as soon as the frame measures (its top off screen), and back to it later.
 * `landing`: three panels, the opened one held at the top by a copy of `MessagePane`'s thread anchor
 * (a ResizeObserver re-scroll), while the body above it lands and grows. `streamPress`: a press inside a
 * stream card's letter, under `readStreamCards`. Bundled by the test;
 * nothing here is product code. */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createThreadRead } from "@ohmail/client-engine";
import { MessageBody } from "../../app/components/MessageBody";
import { createThreadReadDom } from "../../app/shell/reader-seen";
import { readStreamCards } from "../../app/shell/stream-landing-read";

interface Log { reads: string[][]; at: number[] }
const frames = (n: number): Promise<void> =>
  new Promise((done) => {
    const step = (left: number): void => { if (left <= 0) done(); else requestAnimationFrame(() => step(left - 1)); };
    step(n);
  });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scrollerOf(height: number, width: number): HTMLElement {
  const sc = document.createElement("div");
  sc.className = "read-col";
  sc.style.cssText = `height:${height}px;width:${width}px;overflow-y:auto;overflow-anchor:none;position:relative`;
  document.body.replaceChildren(sc);
  return sc;
}

let t0 = 0;
function adapter(sc: HTMLElement, log: Log): void {
  const record = createThreadRead();
  record.enter(Date.now());
  t0 = performance.now();
  createThreadReadDom({
    scroller: sc, record,
    onRead: (ids) => { log.reads.push(ids); log.at.push(Math.round(performance.now() - t0)); },
    onEnter: () => record.enter(Date.now()),
    documentFocused: () => true, visible: () => true, frameHovered: () => false,
  });
}

/** A 600px-table newsletter (framed, not set as prose), `rows` × about 440px, under `pictures` pictures. */
function letter(rows: number, pictures: number): string {
  const cells = Array.from({ length: rows }, (_, i) =>
    `<tr><td style="height:400px;padding:20px;font:16px sans-serif">Section ${i + 1}. ${"A paragraph of the issue. ".repeat(20)}</td></tr>`).join("");
  const pics = Array.from({ length: pictures }, (_, i) =>
    `<tr><td><img src="https://pictures.example.test/p${i}.png" width="600" height="200" alt=""></td></tr>`).join("");
  return `<html><body><table width="600" style="width:600px" cellpadding="0" cellspacing="0">${pics}${cells}</table></body></html>`;
}

async function framed(opts: { rows: number; pictures: number; away: boolean }): Promise<Record<string, unknown>> {
  const log: Log = { reads: [], at: [] };
  const sc = scrollerOf(900, 760);
  const conv = document.createElement("div");
  conv.className = "conv";
  sc.appendChild(conv);
  const root = createRoot(conv);
  flushSync(() => root.render(
    <article className="pm" data-conv-id="m1" data-unseen="" data-body-ready="">
      <div className="msg-from"><b>Sender</b></div>
      <div className="pm-body">
        <MessageBody
          messageId="m1" text="the text part" html={letter(opts.rows, opts.pictures)} remoteLoaded
          imageProxy={(u) => `${location.origin}/api/img?u=${encodeURIComponent(u)}`}
        />
      </div>
    </article>,
  ));
  adapter(sc, log); // the open: ↵ entered the record as the panel mounted
  const frame = (): HTMLIFrameElement | null => sc.querySelector("iframe.mb-frame");
  const tall = (): number => frame()?.getBoundingClientRect().height ?? 0;
  for (let waited = 0; waited < 8000 && sc.querySelector("[data-own-end]") === null; waited += 5) await sleep(5);
  const measuredAt = Math.round(performance.now() - t0);
  const atMeasure = log.reads.map((r) => [...r]);
  for (let waited = 0; waited < 8000 && tall() < 2000; waited += 5) await sleep(5);
  const tallAt = Math.round(performance.now() - t0);
  const atTall = log.reads.map((r) => [...r]);
  if (opts.away) {
    // The person scrolls into the letter's middle as soon as it has its height: its top leaves the
    // screen before the dwell is done.
    sc.scrollTop = 3000;
    sc.dispatchEvent(new Event("scroll"));
    await sleep(1500);
    await frames(4);
  }
  const awayTop = sc.scrollTop;
  const whileAway = log.reads.map((r) => [...r]);
  // Back at (or still at) the top: the sender line and the frame's top on screen.
  sc.scrollTop = 0;
  sc.dispatchEvent(new Event("scroll"));
  await sleep(1500);
  await frames(4);
  return {
    framed: frame() !== null, frameHeight: Math.round(tall()), measuredAt, atMeasure, tallAt, atTall, whileAway, awayTop,
    reads: log.reads, at: log.at,
    endInView: (sc.querySelector("[data-own-end]")?.getBoundingClientRect().top ?? 0) < sc.getBoundingClientRect().bottom,
  };
}

async function landing(opts: { anchor: boolean }): Promise<Record<string, unknown>> {
  const log: Log = { reads: [], at: [] };
  const sc = scrollerOf(700, 600);
  const conv = document.createElement("div");
  conv.className = "conv";
  sc.appendChild(conv);
  const panel = (id: string, body: number, ready: boolean, opened = false): HTMLElement => {
    const el = document.createElement("article");
    el.className = "pm";
    el.dataset.convId = id;
    el.setAttribute("data-unseen", "");
    if (ready) el.setAttribute("data-body-ready", "");
    if (opened) el.setAttribute("aria-current", "true");
    el.style.cssText = "display:block;margin:0 0 20px;padding:12px;border:1px solid #888";
    el.innerHTML = `<div class="msg-from" style="height:24px">From ${id}</div>` +
      `<div class="pm-body"><div class="b" style="height:${body}px"></div><span data-own-end=""></span></div>`;
    conv.appendChild(el);
    return el;
  };
  const z = panel("z", 40, false);
  const a = panel("a", 60, true);
  const b = panel("b", 1600, true, true);
  b.removeAttribute("data-unseen"); // the opened message, read: the case is about `a`
  const anchor = (): void => {
    sc.scrollTop = b.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 14;
  };
  anchor();
  if (opts.anchor) new ResizeObserver(() => anchor()).observe(conv);
  adapter(sc, log);
  await frames(6);
  const before = log.reads.map((r) => [...r]);
  await sleep(30); // out of the frame: the body lands in a task of its own, as a fetch's answer does
  // z's body lands and grows by 400px in that task.
  (z.querySelector(".b") as HTMLElement).style.height = "440px";
  z.setAttribute("data-body-ready", "");
  await frames(10);
  await sleep(1200); // the dwell, and more: what stays on screen is read, what never was is not
  await frames(4);
  const view = sc.getBoundingClientRect();
  const r = a.getBoundingClientRect();
  return { before, reads: log.reads, aInView: r.top >= view.top && r.bottom <= view.bottom };
}

/** Three framed letters, like a Screener preview. */
function three(html: (id: string) => string): HTMLElement {
  const sc = scrollerOf(900, 760);
  const conv = document.createElement("div");
  sc.appendChild(conv);
  createRoot(conv).render(
    <>
      {["p1", "p2", "p3"].map((id) => (
        <MessageBody
          key={id} messageId={id} text="the text part" html={html(id)} remoteLoaded
          imageProxy={(u) => `${location.origin}/api/img?u=${encodeURIComponent(u)}`}
        />
      ))}
    </>,
  );
  return sc;
}
const frameDocs = (sc: HTMLElement): Document[] =>
  [...sc.querySelectorAll("iframe")].flatMap((f) => (f.contentDocument ? [f.contentDocument] : []));

/** Three letters of `each` pictures and one width-only picture whose answer is held back; resolves
 * once every other picture drew, or at 15 s, with the held one's box while it was parked. */
async function pictures(each: number): Promise<{ total: number; drawn: number; parked: { w: number; h: number } | null }> {
  const held = (id: string): string =>
    `<tr><td><img src="https://pictures.example.test/${id}-held.png" width="564" style="max-width:1200px;display:inline" alt=""></td></tr>`;
  const sc = three((id) => letter(1, each).replaceAll("/p", `/${id}-p`).replace("</table>", `${held(id)}</table>`));
  const imgs = (): HTMLImageElement[] => frameDocs(sc).flatMap((d) => [...d.querySelectorAll("img")]);
  const drawn = (): number => imgs().filter((i) => i.naturalWidth === 8).length;
  let parked: { w: number; h: number } | null = null;
  for (let waited = 0; waited < 15_000 && drawn() < 3 * each; waited += 20) {
    const wait: HTMLImageElement | undefined = parked ? undefined : imgs().find((i) => i.getAttribute("width") === "564" && i.hasAttribute("data-ohmail-src"));
    if (wait) { const box: DOMRect = wait.getBoundingClientRect(); parked = { w: Math.round(box.width), h: Math.round(box.height) }; }
    await sleep(20);
  }
  return { total: imgs().length, drawn: drawn(), parked };
}

/** Three letters of `each` cells painted by an inline `background-image` and `each` by a `<style>`
 * sheet's, the first `refused` of each kind refused by the proxy; resolves once every other cell
 * shows its proxied background and nothing is parked, or at 15 s. */
async function backgrounds(each: number, refused = 0): Promise<{ cells: number; shown: number; parked: number }> {
  const sc = three((id) => {
    const at = (k: string, i: number): string => `https://pictures.example.test/${id}-${k}${i}${i < refused ? "-refused" : ""}.png`;
    const rules = Array.from({ length: each }, (_, i) => `.s${i}{background-image:url(${at("s", i)})}`).join("");
    const cell = (attrs: string): string => `<tr><td ${attrs} style="width:600px;height:40px"></td></tr>`;
    const inline = Array.from({ length: each }, (_, i) => `<tr><td style="width:600px;height:40px;background-image:url(${at("i", i)})"></td></tr>`);
    const sheet = Array.from({ length: each }, (_, i) => cell(`class="s${i}"`));
    return `<html><head><style>${rules}</style></head><body><table width="600" cellpadding="0" cellspacing="0">${[...inline, ...sheet].join("")}</table></body></html>`;
  });
  const cells = (): HTMLElement[] => frameDocs(sc).flatMap((d) => [...d.querySelectorAll<HTMLElement>("td")]);
  const shown = (): number => cells().filter((c) => c.ownerDocument.defaultView?.getComputedStyle(c).backgroundImage.includes("/api/img")).length;
  const parked = (): number => frameDocs(sc).reduce((n, d) => n + d.querySelectorAll("[data-ohmail-css-src]").length, 0);
  for (let waited = 0; waited < 15_000 && (shown() < 6 * (each - refused) || parked() > 0); waited += 20) await sleep(20);
  return { cells: cells().length, shown: shown(), parked: parked() };
}

/** A News stream of two unread cards, the first with a sandboxed letter on screen, the second far below;
 * the rule over it, never driven. `pressed()` reports what was read, and when, after the test's press. */
let streamLog: Log = { reads: [], at: [] };
function streamPress(): void {
  streamLog = { reads: [], at: [] };
  const sc = scrollerOf(700, 600);
  sc.className = "stream";
  for (const id of ["c1", "c2"]) {
    const card = document.createElement("article");
    card.className = "scast";
    card.dataset.sid = id;
    card.setAttribute("data-unseen", "");
    card.style.cssText = `display:block;padding:12px;margin-bottom:${id === "c1" ? 1400 : 0}px`;
    card.innerHTML = `<div class="sc-line" style="height:20px">From ${id}</div><div class="sc-clip"><div class="sc-viewer" style="line-height:20px">` +
      `<iframe sandbox="allow-same-origin" style="width:500px;height:300px;border:0" srcdoc="<p style='font:16px/20px sans-serif'>${"Letter text. ".repeat(60)}</p>"></iframe></div></div>`;
    sc.appendChild(card);
  }
  t0 = performance.now();
  readStreamCards({
    scroller: sc, record: createThreadRead(), driven: () => false,
    onRead: (ids) => { streamLog.reads.push(ids); streamLog.at.push(Math.round(performance.now() - t0)); },
  });
}
const pressed = (): Log & { since: number } => ({ ...streamLog, since: Math.round(performance.now() - t0) });

(window as unknown as { rig: unknown }).rig = { framed, landing, pictures, backgrounds, streamPress, pressed };
