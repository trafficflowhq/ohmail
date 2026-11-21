"use client";

import { THREAD_TOP_LINES } from "@ohmail/client-engine";
import { lineHeightOf, viewOf } from "../reading/reader-seen.js";
import { cssRect } from "../geometry/index.js";
import { type StreamItemBox, type StreamLook } from "./read-rule.js";
import type { StreamItemFacts } from "./stream-read-dom.js";
/** Pending previews count their actual sender line and the first three visible text lines. */
function previewLines(card: HTMLElement, id: string, origin: number): StreamItemBox["lines"] {
  const letters = card.querySelectorAll<HTMLElement>("[data-conv-id]");
  const letter = letters.length === 0 ? card : [...letters].find((item) => item.dataset.convId === id);
  if (!letter) return undefined;
  const clip = letter.querySelector(".oh-message-clip");
  const body = letter.querySelector(".oh-message-body, [data-read-body]");
  if (!body) return undefined;
  const text = cssRect(body);
  if (text.height <= 0) return undefined;
  const cut = clip ? cssRect(clip) : text;
  const bottom = Math.min(cut.bottom, text.bottom);
  if (bottom <= text.top || text.top < cut.top - 0.5) return undefined;
  const sender = letter.querySelector("[data-sender-line]");
  const first = sender ? cssRect(sender) : null;
  const lines = THREAD_TOP_LINES * lineHeightOf(body);
  return {
    first: first && first.height > 0 ? { top: first.top - origin, bottom: first.bottom - origin } : null,
    lead: { top: text.top - origin, bottom: Math.min(text.top + lines, bottom) - origin },
    end: { top: bottom - origin, bottom: bottom - origin },
  };
}

const STREAM_READ_STOPS = { stops: "[data-read-stop]", stopsRoot: '[data-kind="reading"]' };

/** The shared panel floats beside the stream's scroller, inside the same reading sheet. */
export function streamReadView(scroller: HTMLElement): ReturnType<typeof viewOf> {
  return viewOf(scroller, STREAM_READ_STOPS);
}

/** Measure the mounted items of the scroller, in the scroller's content px. */
export function measureStream(
  scroller: HTMLElement,
  factsOf: (id: string) => StreamItemFacts | null,
  at: number,
): StreamLook {
  const view = streamReadView(scroller);
  const { scrollTop, clientHeight } = scroller;
  const items: StreamItemBox[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-stream-item]")) {
    const id = el.dataset.streamItem;
    const facts = id ? factsOf(id) : null;
    if (!id || !facts) continue;
    const r = cssRect(el);
    const lines =
      r.bottom > view.top && r.top < view.bottom ? previewLines(el, id, view.top - scrollTop) : undefined;
    items.push({
      id,
      top: r.top - view.top + scrollTop,
      height: r.height,
      unread: facts.unread,
      ready: facts.ready,
      ...(lines ? { lines } : {}),
    });
  }
  items.sort((a, b) => a.top - b.top);
  return {
    scrollTop,
    viewHeight: view.bottom - view.top,
    physicalHeight: clientHeight,
    scrollHeight: scroller.scrollHeight,
    items,
    at,
  };
}

/** The last item whose top stands above the view's foot. */
export function bottomOf(l: StreamLook): string | null {
  const foot = l.scrollTop + l.viewHeight;
  let bottom: string | null = null;
  for (const item of l.items) if (item.top < foot) bottom = item.id;
  return bottom;
}

/** A jump to an end in flight: `flag` stands from its key until the scroller has not moved for the landing's quiet. */
