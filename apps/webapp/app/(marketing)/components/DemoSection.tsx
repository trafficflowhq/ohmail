"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslations } from "next-intl";
import { Kbd, useTheme } from "@ohmail/ui";
import { Reveal } from "./Reveal";
import { OMARCHY_DEMO_THEMES } from "./omarchy-demo-themes";

const DEMO_SRC = "/demo";

/* ── the theme explorer's feed ────────────────────────────────────────
   The demo's ohmarchy face can wear any Omarchy theme (OHMARCHY-PLAN.md
   §2-3d): picking one injects that theme's mapped token values into the
   iframe's own document as ONE rule scoped to `:root[data-face="ohmarchy"]`
   — the same shape as the desktop's live theme feed (apps/desktop/src/
   omarchy.ts), for the same reasons: scoped, the rule is inert the moment
   the face comes off, so it can never restyle the paper face by side
   effect. `!important` per declaration is that module's cascade argument,
   which holds identically here: the demo document's system-dark token
   block is a (0,3,0) selector and would silently outrank this rule's
   (0,2,0) on every slot both define. The values are the committed,
   law-derived set (omarchy-demo-themes.ts is generated from mapping.js
   over the fixtures and pinned by test), so no fence is needed — nothing
   user-authored ever reaches this rule. */
const DEMO_THEME_STYLE_ID = "ohmail-omarchy-demo";

function applyDemoTheme(doc: Document, tokens: Record<string, string> | null): void {
  const prev = doc.getElementById(DEMO_THEME_STYLE_ID);
  if (tokens === null) {
    prev?.remove();
    return;
  }
  let style = prev as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = DEMO_THEME_STYLE_ID;
    doc.head.appendChild(style);
  }
  const lines = Object.entries(tokens).map(([name, value]) => `  ${name}: ${value} !important;`);
  style.textContent = `:root[data-face="ohmarchy"] {\n${lines.join("\n")}\n}`;
}

/** Layout effects are a client-only concern; on the server they would only
    warn. The component still server-renders — just without the geometry. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* ── the annotations ──────────────────────────────────────────────────
   Each card points at a REGION OF THE DEMO, not at a decorative spot on
   the frame: `sel` is resolved inside the iframe's own document (same
   origin, so this is a plain querySelector) and the leader is drawn from
   the card to that element's outlined box. `fallback` is a fraction of
   the frame used when the element is missing, scrolled out of the demo's
   viewport, or the document could not be read — the annotation still
   points at the right neighbourhood rather than at nothing.

   Sides are chosen by where the target lives: the two rail entries are
   reachable from the left gutter in ~40px of leader, the two reading-pane
   chips from the right in ~60px. Nothing has to cross the app.

   The whole layer — cards, leaders and rings together — retires on the
   visitor's first real interaction with the demo (see onFrameLoad). The
   card and its pointer are one object: a card that outlives its leader is
   an unanchored note about a chip that has since scrolled away.
   ──────────────────────────────────────────────────────────────────── */
type Side = "left" | "right";

interface Anno {
  id: string;
  side: Side;
  sel: string;
  fallback: [number, number];
  title: string;
  body: string;
}

const ANNOS: Anno[] = [
  {
    id: "ohbox",
    side: "left",
    // The rail entries carry `data-rail-id` (RailNav); the two reading-pane chips carry
    // `data-chip` (the Chip primitive). Both are stable hooks on the SHIPPED UI, so the
    // leaders anchor to the real elements rather than to a guessed spot.
    //
    // THE FOUR CARDS ARE THE PRODUCT'S FOUR CLAIMS, anchored to the part of the app each
    // is about: the Ohbox (only mail you said yes to — the hero's own lead, repeated
    // verbatim), the
    // Screener (one press decides; spam to the provider's native Junk, the sender rule
    // remembers, the unsubscribe goes out where the list offers one click), the rationale
    // chip (every mail says why, and that rule is stored IN the mailbox as open JSON — the
    // leave-anytime half), and the tracker chip (nothing on faith: open source, a real
    // desktop client, the blocked pixel as the visible proof). Each sentence is judged
    // against the code by `landing-mailbox-truth.test.ts`.
    sel: '.rail [data-rail-id="ohbox"]',
    fallback: [0.13, 0.2],
    title: "calloutOhboxTitle",
    body: "calloutOhbox",
  },
  {
    id: "screener",
    side: "left",
    sel: '.rail [data-rail-id="screener"]',
    fallback: [0.13, 0.4],
    title: "calloutScreenerTitle",
    body: "calloutScreener",
  },
  {
    id: "why",
    side: "right",
    sel: '.chip[data-chip="rationale"]',
    fallback: [0.83, 0.32],
    title: "calloutWhyTitle",
    body: "calloutWhy",
  },
  {
    id: "tracker",
    side: "right",
    sel: '.chip[data-chip="tracker"]',
    fallback: [0.82, 0.41],
    title: "calloutTrackerTitle",
    body: "calloutTracker",
  },
];

/** Page margin needed per side before floating the cards is worth doing.
    Below it the cards are a row under the frame (the designed fallback) —
    they never overlap the live app and never widen the page. 150 is what a
    1366px laptop has to spare beside the 1000px frame, which is why the
    float threshold lands exactly there. */
const MIN_GUTTER = 150;
const CARD_MIN = 140;
const CARD_MAX = 232;
/** clearance between two stacked cards, and from the frame's edges */
const VGAP = 12;
const PAD = 6;

interface Ring {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}
interface Item {
  id: string;
  top: number;
  path: string;
  ring: string;
}
interface Geo {
  mode: "row" | "float";
  boxW: number;
  boxH: number;
  offX: number;
  items: Item[];
}

const ROW: Geo = { mode: "row", boxW: 0, boxH: 0, offX: 0, items: [] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** rounded-rect as a path, so it can share the leader's draw-in dash trick */
function roundRectPath(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  return (
    `M ${x + rr} ${y} H ${x + w - rr} A ${rr} ${rr} 0 0 1 ${x + w} ${y + rr}` +
    ` V ${y + h - rr} A ${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h}` +
    ` H ${x + rr} A ${rr} ${rr} 0 0 1 ${x} ${y + h - rr}` +
    ` V ${y + rr} A ${rr} ${rr} 0 0 1 ${x + rr} ${y} Z`
  );
}

/** same-origin read, defensive: a cross-origin or not-yet-parsed frame
    simply yields null and every annotation falls back to its fraction */
function docOf(frame: HTMLIFrameElement | null): Document | null {
  if (!frame) return null;
  try {
    return frame.contentDocument ?? null;
  } catch {
    return null;
  }
}
function safeQuery(doc: Document, sel: string): Element | null {
  try {
    return doc.querySelector(sel);
  } catch {
    return null; //   :has() on an engine that does not support it
  }
}

/** sketch: assembled, never travelled (server render, no-JS, reduced motion)
    pending: parked on the first keyframe, waiting for the viewport
    assembling: the planes are travelling
    settled: arrived — holding until the document is ready
    live: crossfading to the real app, then gone */
type Phase = "sketch" | "pending" | "assembling" | "settled" | "live";

/**
 * The centerpiece: the real Blanc prototype, live. No poster, no press-play
 * — the iframe mounts as the section approaches (so the first paint of the
 * page never waits for it) and the app is immediately usable.
 *
 * What plays instead of a play button is a BUILD-UP: the three panes of the
 * app arrive as separate planes in a shallow 3D field — rail from the left,
 * list from below, reading pane from the right — and hand over to the real
 * iframe once both the choreography and the document are done. It runs once,
 * on first viewport entry. Reduced motion sees the assembled sketch and then
 * the app, with no travel.
 *
 * The annotations are measured, not guessed: see ANNOS above.
 */
export function DemoSection() {
  const t = useTranslations("demo");
  const tf = useTranslations("face");
  const { resolved, face } = useTheme();
  /* the explorer's pick: an Omarchy theme slug, or null for ohmail's own pairing
     (the static tokyo-night / flexoki-light defaults, following the scheme) */
  const [demoTheme, setDemoTheme] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false); //   iframe in the DOM
  const [loaded, setLoaded] = useState(false); //     iframe fired load
  const [phase, setPhase] = useState<Phase>("sketch");
  const [overlay, setOverlay] = useState(true); //    build-up still present
  const [touched, setTouched] = useState(false); //   user has used the app
  const [geo, setGeo] = useState<Geo>(ROW);
  /* ── full-window ────────────────────────────────────────────────────
     The frame can take the whole viewport: the green dot opens it, the
     first press INTO the demo opens it, Escape / the red dot / the close
     control / the backdrop return to the page — at the scroll position
     the visitor left, with focus back on whatever opened it. The iframe
     is the SAME element throughout (only attributes change around it), so
     the app's state survives the move in both directions. */
  const [full, setFull] = useState(false);
  const fullRef = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const savedScroll = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cardRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const reduced = useRef(false);
  const lastGeo = useRef("");

  /* ── mount the demo document on approach ────────────────────────────
     One viewport of lead time, not two: at 900px of margin the observer
     fired at scrollY 0 on every desktop load, so the demo's 159 KB
     document was spent whether or not the visitor ever scrolled to it.
     240px is enough to have the frame painted before it is read and still
     small enough to be a real condition — on a laptop the section is
     within a screen of the fold anyway, which is the case where loading it
     IS correct. First paint never waits either way: this runs in an effect,
     after hydration. */
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          io.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* ── arm the build-up before first paint, then play it on entry ─── */
  useIsoLayoutEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const el = wrapRef.current;
    if (reduced.current || !el || typeof IntersectionObserver === "undefined") return;
    /* already on screen at load (a deep link to #demo): play it at once */
    if (el.getBoundingClientRect().top < window.innerHeight * 0.75) {
      setPhase("assembling");
      return;
    }
    setPhase("pending");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setPhase("assembling");
            io.disconnect();
          }
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* the planes' run: 210ms of stagger + 680ms of travel, then they hold */
  useEffect(() => {
    if (phase !== "assembling") return;
    const id = window.setTimeout(() => setPhase("settled"), 900);
    return () => window.clearTimeout(id);
  }, [phase]);

  /* Hand over to the iframe — but only once BOTH the choreography and the
     document are done, in whichever order that happens. The overlay is
     opaque, so it is also what hides the blank frame until then. */
  useEffect(() => {
    if (loaded && (phase === "settled" || phase === "sketch")) setPhase("live");
  }, [loaded, phase]);

  /* …and then it leaves. Deliberately a second effect: setting the phase in
     the one above re-runs it, and a cleanup there would cancel this very
     timer — leaving an invisible opaque layer sitting on top of a live app,
     swallowing every click. */
  useEffect(() => {
    if (phase !== "live") return;
    const id = window.setTimeout(() => setOverlay(false), reduced.current ? 20 : 480);
    return () => window.clearTimeout(id);
  }, [phase]);

  const openFull = useCallback((trigger: HTMLElement | null) => {
    if (fullRef.current) return;
    fullRef.current = true;
    returnFocus.current = trigger;
    savedScroll.current = window.scrollY;
    /* the frame leaves the flow, so the stage keeps its height — no jump behind the overlay */
    const wrap = wrapRef.current;
    if (wrap) wrap.parentElement?.style.setProperty("--wrap-h", `${wrap.offsetHeight}px`);
    setFull(true);
  }, []);

  const closeFull = useCallback(() => {
    if (!fullRef.current) return;
    fullRef.current = false;
    setFull(false);
  }, []);

  /* scroll lock + focus, keyed on the state so the DOM the effect sees is the DOM the
     state describes. Escape is listened for on the window: it must work with focus on the
     close control, on a dot, or nowhere in particular.

     The second listener is the half of the focus trap Tab-key handling cannot reach: a Tab
     leaving the embedded app's last control never bubbles to this document — the browser
     simply moves focus to the page's next control behind the dialog. `focusin` DOES fire
     here when that happens, so focus landing outside the wrap while the dialog is open is
     redirected to the dialog's first stop. Backward exits (shift-Tab off the first stop)
     never reach this path: `onDialogKey` wraps them before the browser moves. */
  useEffect(() => {
    const root = document.documentElement;
    if (full) {
      root.dataset.demoFull = "on";
      closeRef.current?.focus();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") closeFull();
      };
      const onFocusIn = (e: FocusEvent) => {
        const wrap = wrapRef.current;
        if (!wrap || !(e.target instanceof Node) || wrap.contains(e.target)) return;
        const first = wrap.querySelector<HTMLElement>("button:not([disabled]), a[href], iframe");
        first?.focus();
      };
      window.addEventListener("keydown", onKey);
      document.addEventListener("focusin", onFocusIn);
      return () => {
        window.removeEventListener("keydown", onKey);
        document.removeEventListener("focusin", onFocusIn);
      };
    }
    delete root.dataset.demoFull;
    return undefined;
  }, [full, closeFull]);

  /* the return trip: only after a real open, never on mount */
  const wasFull = useRef(false);
  useEffect(() => {
    if (full) {
      wasFull.current = true;
      return;
    }
    if (!wasFull.current) return;
    wasFull.current = false;
    window.scrollTo({ top: savedScroll.current });
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
  }, [full]);

  /* the focus trap: Tab cycles inside the dialog. The iframe is one stop — once focus is
     inside the app, the app's own Tab order runs until it leaves the document again. */
  const onDialogKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!fullRef.current || e.key !== "Tab") return;
    const root = e.currentTarget;
    const stops = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], iframe'),
    );
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  /* ── annotation geometry ──────────────────────────────────────────
     One imperative pass: decide the mode from the page's real content
     width (never 100vw — that includes the scrollbar and would overflow),
     write the card width so the cards can be measured at their final
     size, then resolve every target and lay the leaders out. */
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const body = bodyRef.current;
    if (!wrap || !body) return;
    const pageW = document.documentElement.clientWidth;
    const wr = wrap.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    /* 20px of page margin stays empty on both sides: a card that ends 4px
       from the viewport edge reads as an accident, not as a margin note */
    const gutter = (pageW - wr.width) / 2 - 20;
    if (gutter < MIN_GUTTER || br.width < 700) {
      wrap.dataset.mode = "row";
      if (lastGeo.current !== "row") {
        lastGeo.current = "row";
        setGeo(ROW);
      }
      return;
    }
    const cardW = clamp(gutter - 14, CARD_MIN, CARD_MAX);
    const gap = clamp(gutter - cardW - 8, 10, 34);
    wrap.dataset.mode = "float";
    wrap.style.setProperty("--co-w", `${cardW}px`);
    wrap.style.setProperty("--co-gap", `${gap}px`);

    const doc = docOf(frameRef.current);
    const dx = br.left - wr.left;
    const dy = br.top - wr.top;

    const placed = ANNOS.map((a) => {
      let ring: Ring | null = null;
      const el = doc ? safeQuery(doc, a.sel) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        const visible =
          r.width > 8 && r.height > 6 && r.top > -4 && r.bottom < br.height + 4;
        if (visible) {
          const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 10;
          ring = { x: r.left + dx - 4, y: r.top + dy - 4, w: r.width + 8, h: r.height + 8, r: rad + 4 };
        }
      }
      if (!ring) {
        const [fx, fy] = a.fallback;
        const w = 132;
        const h = 34;
        ring = { x: br.width * fx + dx - w / 2, y: br.height * fy + dy - h / 2, w, h, r: 14 };
      }
      const card = cardRefs.current[a.id];
      return { a, ring, h: card?.offsetHeight ?? 88, top: 0 };
    });

    /* Cards sit level with what they point at, so the leader is a straight
       hairline; only a collision bends one. Stacks are then kept inside the
       frame's height. */
    for (const side of ["left", "right"] as Side[]) {
      const list = placed
        .filter((p) => p.a.side === side)
        .sort((p, q) => p.ring.y + p.ring.h / 2 - (q.ring.y + q.ring.h / 2));
      let prevBottom = -1e9;
      for (const p of list) {
        p.top = Math.max(p.ring.y + p.ring.h / 2 - p.h / 2, prevBottom + VGAP);
        prevBottom = p.top + p.h;
      }
      if (list.length) {
        const over = prevBottom - (wr.height - PAD);
        if (over > 0) for (const p of list) p.top -= over;
        const short = PAD - list[0]!.top;
        if (short > 0) for (const p of list) p.top += short;
      }
    }

    const offX = gap + cardW;
    const items: Item[] = placed.map((p) => {
      const y0 = p.top + p.h / 2;
      const left = p.a.side === "left";
      const x0 = left ? cardW + 1 : wr.width + offX + gap - 1;
      const tx = left ? offX + p.ring.x - 2 : offX + p.ring.x + p.ring.w + 2;
      const ty = p.ring.y + p.ring.h / 2;
      /* control points stay inside the horizontal span (2k < |dx|), or the
         curve doubles back on itself and reads as a swoop, not a pointer */
      const k = Math.min(Math.abs(tx - x0) * 0.42, 36) * (left ? 1 : -1);
      const path =
        Math.abs(ty - y0) < 3
          ? `M ${x0.toFixed(1)} ${y0.toFixed(1)} H ${tx.toFixed(1)}`
          : `M ${x0.toFixed(1)} ${y0.toFixed(1)} C ${(x0 + k).toFixed(1)} ${y0.toFixed(1)}, ` +
            `${(tx - k).toFixed(1)} ${ty.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      return {
        id: p.a.id,
        top: p.top,
        path,
        ring: roundRectPath(offX + p.ring.x, p.ring.y, p.ring.w, p.ring.h, p.ring.r),
      };
    });

    const next: Geo = { mode: "float", boxW: wr.width + offX * 2, boxH: wr.height, offX, items };
    /* the ResizeObserver below fires on the row → float switch (the wrap
       loses the card row's height); bail out when nothing actually moved */
    const key = JSON.stringify(next);
    if (key === lastGeo.current) return;
    lastGeo.current = key;
    setGeo(next);
  }, []);

  useIsoLayoutEffect(() => {
    measure();
    let raf = 0;
    const again = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", again);
    const ro =
      typeof ResizeObserver !== "undefined" && wrapRef.current
        ? new ResizeObserver(again)
        : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", again);
      ro?.disconnect();
    };
  }, [measure]);

  /* The embedded app follows the page's theme. The app keeps its theme in one
     attribute on its own <html> (absent = system), so the landing can hand it
     down — a light app inside a dark page would read as two products. Its own
     theme toggle still wins until the page changes. */
  useEffect(() => {
    const doc = docOf(frameRef.current);
    if (!doc || !loaded) return;
    try {
      doc.documentElement.dataset.theme = resolved;
    } catch {
      /* cross-origin: the demo keeps its own theme, which is fine */
    }
  }, [resolved, loaded]);

  /* …and the page's FACE, the same way: the demo is the site's proof, so it wears the
     face the site wears. The demo document mostly agrees on its own (same origin, same
     storage keys, same boot resolution), but an in-session flip of the toggle must reach
     an already-loaded frame — this is that reach. Paper is absence, per the contract. */
  useEffect(() => {
    const doc = docOf(frameRef.current);
    if (!doc || !loaded) return;
    try {
      if (face === "ohmarchy") doc.documentElement.dataset.face = "ohmarchy";
      else delete doc.documentElement.dataset.face;
    } catch {
      /* cross-origin: the demo keeps its own face */
    }
  }, [face, loaded]);

  /* the explorer's pick reaches the frame whenever either changes */
  useEffect(() => {
    const doc = docOf(frameRef.current);
    if (!doc || !loaded) return;
    const picked =
      demoTheme === null
        ? null
        : (OMARCHY_DEMO_THEMES.find((th) => th.slug === demoTheme)?.tokens ?? null);
    try {
      applyDemoTheme(doc, picked);
    } catch {
      /* a document that refuses a style element keeps the static defaults */
    }
  }, [demoTheme, loaded]);

  /* Re-measure once the demo's own layout exists, and retire the whole
     annotation layer — leaders, rings AND cards — the moment the visitor
     actually uses the app. A guide that stays drawn over a live interface
     is graffiti, and its geometry is one view change away from being a lie.

     `scroll` rather than `wheel`: a wheel event over a region the demo
     cannot scroll bubbles out to scroll the PAGE, so wheel fires on a
     visitor who is merely scrolling past with the cursor over the frame —
     the annotations would retire before they had been read. A scroll event
     inside the demo's document only exists if something in the demo
     actually moved. It does not bubble, but it does propagate down the
     capture phase, which is why this listener sees it. */
  const onFrameLoad = useCallback(() => {
    setLoaded(true);
    requestAnimationFrame(measure);
    const doc = docOf(frameRef.current);
    if (!doc) return;
    const go = () => setTouched(true);
    const opts = { capture: true, once: true, passive: true } as const;
    doc.addEventListener("pointerdown", go, opts);
    doc.addEventListener("keydown", go, { capture: true, once: true });
    doc.addEventListener("scroll", go, opts);
    /* Using the demo IS entering it: the first press inside the frame opens the full
       window, and the press itself still lands in the app. On `pointerup`, NOT
       `pointerdown`: by pointerup the click's targets are already resolved, so the
       relayout the expansion causes cannot re-hit-test the release against a moved
       control and swallow the visitor's first click — which is exactly what expanding
       on pointerdown did. Persistent, not `once` — after a return to the page the next
       press opens it again, so the frame behaves the same way every time it is touched. */
    const enter = () => {
      if (!fullRef.current) openFull(frameRef.current);
    };
    doc.addEventListener("pointerup", enter, { capture: true, passive: true });
    /* Escape pressed INSIDE the app returns to the page ONLY when the app has nothing of
       its own for Escape to mean. The app's own consumers handle Escape without stopping
       propagation or preventing default, so "was it handled" cannot be read off the event —
       it is read off the DOM, in two steps:

       · A dialog on screen (the Reader, the palette, a reply run — all `role="dialog"`;
         the Reader also marks `body.reading`) reliably owns the key: those surfaces always
         close themselves on Escape, so the outer window simply yields.
       · A focused field MIGHT own it — a search clears itself, some fields blur — or might
         bind nothing at all, in which case Escape must still be a way out of the full
         window rather than a dead key. So the decision waits one macrotask, until after
         every in-app handler has run: if the Escape visibly did something (focus moved,
         the field's text changed, a dialog appeared or the reading marker flipped), it was
         the app's; if the demo looks exactly as it did, nothing consumed it and the full
         window closes. */
    /* Duck-typed, never instanceof: the demo document is another realm — its elements are
       not instances of THIS window's Element/HTMLInputElement, in every real browser. */
    const fieldValue = (el: Element | null): string | null =>
      el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")
        ? (el as HTMLInputElement).value
        : null;
    const surfaceOpen = () =>
      doc.querySelector('[role="dialog"]') !== null ||
      (doc.body?.classList.contains("reading") ?? false);
    const isField = (el: unknown): el is Element =>
      typeof (el as Element | null)?.matches === "function" &&
      ((el as Element).matches("input, textarea, select, [contenteditable]") ||
        (el as HTMLElement).isContentEditable === true);
    /* A consumer that calls stopPropagation (the recipient autocomplete closing its list)
       changes nothing this file can probe — same focus, same text, no dialog. But stopping
       propagation IS observable from here: the capture listener below is the first to see
       every Escape, and this bubble listener is the last — an Escape that never arrives
       back at the document was stopped by whoever consumed it. */
    let bubbledEscape: KeyboardEvent | null = null;
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") bubbledEscape = e;
    });
    /* CAPTURE phase, deliberately: the snapshot below must be taken before ANY of the
       app's handlers run — a field's own keydown handler fires before a document-level
       bubble listener ever would, and a snapshot taken after it sees the post-consumption
       state and reads a consumed key as an idle one. */
    doc.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !fullRef.current) return;
        if (surfaceOpen()) return; // the dialog's Escape, not ours
        /* the key is dispatched to the focused element, so the event target is the field —
           and stays readable in environments whose activeElement never enters the frame */
        const field = isField(e.target) ? e.target : isField(doc.activeElement) ? doc.activeElement : null;
        if (!field) {
          closeFull();
          return;
        }
        const value = fieldValue(field);
        const focusThen = doc.activeElement;
        window.setTimeout(() => {
          if (!fullRef.current) return;
          const untouched =
            bubbledEscape === e && // stopped propagation = consumed, wherever, however
            !e.defaultPrevented &&
            doc.activeElement === focusThen &&
            fieldValue(field) === value &&
            !surfaceOpen();
          if (untouched) closeFull();
        }, 0);
      },
      { capture: true },
    );
  }, [measure, openFull, closeFull]);

  return (
    <section className="l-demo" id="demo" aria-labelledby="demo-title" ref={sectionRef}>
      <Reveal className="l-demo-head">
        <h2 id="demo-title" className="l-h2">
          {t("heading")}
        </h2>
        <p className="l-lede">{t("sub")}</p>
      </Reveal>

      <div className="l-demo-stage" data-full={full ? "" : undefined}>
        {/* the backdrop is a control, not decoration: a press on it returns to the page */}
        {full ? (
          <button
            type="button"
            className="l-demo-backdrop"
            aria-label={t("closeFull")}
            tabIndex={-1}
            onClick={closeFull}
          />
        ) : null}
        <div
          className="l-frame-wrap"
          ref={wrapRef}
          data-mode="row"
          data-anno={phase === "live" ? "on" : undefined}
          data-touched={touched ? "" : undefined}
          data-full={full ? "" : undefined}
          role={full ? "dialog" : undefined}
          aria-modal={full ? true : undefined}
          aria-label={full ? t("iframeTitle") : undefined}
          onKeyDown={onDialogKey}
        >
          <figure className="l-frame">
            <figcaption className="l-chrome">
              {/* the window dots are the window's controls. Red closes the full window
                  (inert on the page — there is nothing to close there), yellow is the
                  one honest no-op and stays chrome, green opens the full window and,
                  open, brings the page back. */}
              <span className="l-dots">
                <button
                  type="button"
                  className="l-dot is-close"
                  aria-label={t("dotClose")}
                  disabled={!full}
                  onClick={closeFull}
                />
                <i className="l-dot is-inert" aria-hidden="true" />
                <button
                  type="button"
                  className="l-dot is-expand"
                  aria-label={full ? t("dotRestore") : t("dotExpand")}
                  aria-pressed={full}
                  onClick={(e) => (full ? closeFull() : openFull(e.currentTarget))}
                />
              </span>
              <span className="l-urlbar">
                <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="3.4" y="7" width="9.2" height="6" rx="1.6" />
                  <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
                </svg>
                {t("urlbar")}
              </span>
              {full ? (
                <button type="button" className="l-frame-close" ref={closeRef} onClick={closeFull}>
                  {t("closeFull")}
                  <Kbd>esc</Kbd>
                </button>
              ) : (
                <span className="l-live-badge" aria-hidden="true">
                  <i className="l-live-dot" />
                  {t("badge")}
                </span>
              )}
            </figcaption>

            <div className="l-frame-body" ref={bodyRef}>
              {mounted ? (
                <iframe
                  className="l-demo-iframe"
                  src={DEMO_SRC}
                  title={t("iframeTitle")}
                  loading="eager"
                  ref={frameRef}
                  onLoad={onFrameLoad}
                />
              ) : null}
              {overlay ? <BuildUp phase={phase} /> : null}
              <noscript>
                <a className="l-demo-noscript btn primary" href={DEMO_SRC}>
                  {t("openNewTab")}
                </a>
              </noscript>
            </div>
          </figure>

          {/* the leader lines and region outlines, in a box that spans the
              frame plus both card gutters; every coordinate comes from the
              measure pass above. Retired by [data-touched], together with
              the cards they belong to. */}
          {geo.mode === "float" ? (
            <svg
              className="l-anno"
              width={geo.boxW}
              height={geo.boxH}
              viewBox={`0 0 ${geo.boxW} ${geo.boxH}`}
              style={{ left: -geo.offX }}
              aria-hidden="true"
            >
              {geo.items.map((it, i) => (
                <g key={it.id} style={{ "--i": i } as CSSProperties}>
                  <path className="l-anno-ring" d={it.ring} pathLength={1} />
                  <path className="l-anno-lead" d={it.path} pathLength={1} />
                </g>
              ))}
            </svg>
          ) : null}

          <ul className="l-callouts" aria-label={t("calloutsLabel")}>
            {ANNOS.map((a, i) => {
              const item = geo.items.find((it) => it.id === a.id);
              return (
                <li
                  key={a.id}
                  className={`l-callout l-callout-${a.side}`}
                  ref={(el) => {
                    cardRefs.current[a.id] = el;
                  }}
                  style={{ "--co-top": item ? `${item.top}px` : undefined, "--i": i } as CSSProperties}
                >
                  <div className="l-callout-card">
                    <b>{t(a.title)}</b>
                    <span>{t(a.body)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* ── the theme explorer — the demo's ohmarchy face flips through every Omarchy
            theme the fixtures carry. Appearance-scoped UI, not a fork: it renders under
            the ohmarchy face only because it is a CONTROL over that face's theming (the
            census row argues it as `setting`), and everything it changes is one injected
            token rule in the frame. Buttons with aria-pressed rather than a radiogroup:
            each swatch is independently tabbable, which for 23 targets beats a roving
            tabindex nobody expects on a marketing page. */}
        {face === "ohmarchy" ? (
          <div className="l-oma-picker">
            <span className="l-oma-lead" id="oma-picker-label">
              {tf("explorerLead")}
            </span>
            <span className="l-oma-swatches" role="group" aria-labelledby="oma-picker-label">
              <button
                type="button"
                className="l-oma-sw is-default"
                aria-pressed={demoTheme === null}
                title={tf("explorerDefault")}
                aria-label={tf("explorerDefault")}
                onClick={() => setDemoTheme(null)}
              />
              {OMARCHY_DEMO_THEMES.map((th) => (
                <button
                  key={th.slug}
                  type="button"
                  className="l-oma-sw"
                  aria-pressed={demoTheme === th.slug}
                  title={th.name}
                  aria-label={th.name}
                  style={
                    {
                      "--sw-bg": th.swatch.bg,
                      "--sw-fg": th.swatch.fg,
                      "--sw-ac": th.swatch.accent,
                    } as CSSProperties
                  }
                  onClick={() => setDemoTheme(th.slug)}
                />
              ))}
            </span>
            <span className="l-oma-name" aria-live="polite">
              {demoTheme === null
                ? tf("explorerDefault")
                : (OMARCHY_DEMO_THEMES.find((th) => th.slug === demoTheme)?.name ?? "")}
            </span>
          </div>
        ) : null}

        {/* the keyboard hints live here rather than in a pointer callout:
            they are about the whole app, not about one region of it */}
        <p className="l-demo-hints">
          <span className="l-demo-hints-lead">{t("hintsLabel")}</span>
          <span>
            <Kbd>⌘K</Kbd> {t("hintCmdk")}
          </span>
          <span>
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> {t("hintMove")}
          </span>
          <span>
            <Kbd>↵</Kbd> {t("hintRead")}
          </span>
          <span>
            <Kbd>g</Kbd>
            <Kbd>s</Kbd> {t("hintScreen")}
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * The build-up: three planes of the app in a shallow perspective field,
 * assembling into one surface. It is also the poster — rendered on the
 * server, so a no-JS or headless visit sees the app's shape rather than a
 * hole, and the planes only ever travel when JS, motion and a viewport
 * entry all agree.
 */
function BuildUp({ phase }: { phase: Phase }) {
  const t = useTranslations("demo");
  return (
    <div className="l-buildup" data-phase={phase} aria-hidden="true">
      <div className="l-plane l-plane-rail">
        {/* oh | mail, split so `.l-plane-mark em` can carry accent-ink. The rendered
            textContent is pinned by a suite — a grep for the brand as one string
            cannot see a mark split across elements. */}
        <span className="l-plane-mark">
          <em>oh</em>mail
        </span>
        <span className="l-plane-item is-on">{t("railA")}</span>
        <span className="l-plane-item">{t("railB")}</span>
        <span className="l-plane-item">{t("railC")}</span>
        <span className="l-plane-item is-hot">
          {t("railD")}
          <i className="l-plane-cnt">3</i>
        </span>
        <span className="l-plane-bar" style={{ width: "72%" }} />
        <span className="l-plane-bar" style={{ width: "56%" }} />
        <span className="l-plane-bar" style={{ width: "64%" }} />
      </div>
      <div className="l-plane l-plane-list">
        <span className="l-plane-doorbell">
          <span className="l-plane-avs">
            <i>L</i>
            <i>P</i>
            <i>J</i>
          </span>
          {t("waiting")}
        </span>
        {[88, 72, 80, 60, 76, 68].map((w, i) => (
          <span className="l-plane-row" key={i}>
            <i className="l-plane-av" />
            <span className="l-plane-bar" style={{ width: `${w}%` }} />
          </span>
        ))}
      </div>
      <div className="l-plane l-plane-read">
        <span className="l-plane-row">
          <i className="l-plane-av" />
          <span className="l-plane-bar" style={{ width: "64%" }} />
        </span>
        <span className="l-plane-head" />
        <span className="l-plane-chips">
          <i />
          <i />
        </span>
        {[96, 88, 92, 74, 90, 62].map((w, i) => (
          <span className="l-plane-line" key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}
