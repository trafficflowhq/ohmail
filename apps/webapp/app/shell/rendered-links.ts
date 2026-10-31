/**
 * THE LINKS ON SCREEN, TO THE SHELL. The desktop shell opens an http(s) address in the person's
 * browser only on their own click, and only when it is a link something in this window drew — a
 * message's anchors (the frame's and the prose path's), the editor's (a draft's, a signature's),
 * the Screener's unsubscribe link, the account page an answer named — or one of the shell's own
 * constant links (`rendered_links.rs`).
 * Each renderer reports what it draws, per mount, through {@link useRenderedLinks}, and the shell
 * keeps a bounded list per surface.
 *
 * A registration, armed by the desktop entry (`apps/desktop/src/main.tsx`) before the first render,
 * and `null` everywhere else: the web app and the served host client report into nothing. This file
 * names no shell command, so a bundle that carries it carries none (`scan-artifact.mjs`).
 */
import { useEffect, useState } from "react";

/** Where a report goes: the shell's list in the desktop window, nowhere elsewhere. */
export type RenderedLinksSink = (surface: string, hrefs: readonly string[], asks: readonly string[]) => void;

/** One surface's report inside a batch: the same meaning as one {@link RenderedLinksSink} call. */
export interface RenderedLinksReport {
  surface: string;
  hrefs: readonly string[];
  /** The marked ones among them (`markElsewhere`): the shell asks before it opens one. */
  asks: readonly string[];
}

/** The batched sink: every surface's latest report since the last flush, in report order. */
export type RenderedLinksBatchSink = (reports: readonly RenderedLinksReport[]) => void;

let sink: RenderedLinksSink | null = null;
let batchSink: RenderedLinksBatchSink | null = null;

/** Point reports at the shell, one call per report, or pass `null` to take that away. */
export function setRenderedLinksSink(next: RenderedLinksSink | null): void {
  sink = next;
  batchSink = null;
  pending.clear();
}

/**
 * Point reports at the shell IN BATCHES — the desktop window's way. A switch into News mounted
 * a viewer per card, and each one's report was its own message across the bridge: sixty in, sixty
 * out when the view was left. Reports are now held per surface (the latest wins, an empty one
 * included) and sent together once, in the task after the next paint, so the press's own frame
 * carries none of them; a removal waits for the same flush, a frame at most (a timer stands in
 * when no frame comes, as in a hidden window).
 */
export function setRenderedLinksBatchSink(next: RenderedLinksBatchSink | null): void {
  batchSink = next;
  sink = null;
  pending.clear();
}

/** Held reports by surface, in the order their latest report came. */
const pending = new Map<string, { hrefs: readonly string[]; asks: readonly string[] }>();
let flushArmed = false;
let fallback: ReturnType<typeof setTimeout> | null = null;

/** How long a held report waits when no animation frame comes (a minimized window). */
const FLUSH_FALLBACK_MS = 100;

function armFlush(): void {
  if (flushArmed) return;
  flushArmed = true;
  fallback = setTimeout(flushRenderedLinks, FLUSH_FALLBACK_MS);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => setTimeout(flushRenderedLinks, 0));
  }
}

/** Send every held report now, as one batch. A no-op with nothing held. */
export function flushRenderedLinks(): void {
  flushArmed = false;
  if (fallback !== null) clearTimeout(fallback);
  fallback = null;
  if (pending.size === 0) return;
  const reports = [...pending].map(([surface, { hrefs, asks }]) => ({ surface, hrefs, asks }));
  pending.clear();
  batchSink?.(reports);
}

/**
 * Report one surface's links, and the marked ones among them; an empty list removes the surface.
 * Nothing happens with no sink.
 */
export function reportRenderedLinks(surface: string, hrefs: readonly string[], asks: readonly string[] = []): void {
  if (batchSink) {
    pending.delete(surface);
    pending.set(surface, { hrefs, asks });
    armFlush();
    return;
  }
  sink?.(surface, hrefs, asks);
}

/** The address a renderer reports for `raw`: its `URL.href` when it is absolute http(s), else `null`. */
export function linkHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

let mounts = 0;

/**
 * Report what this mount draws while it is mounted: a change reports again, the unmount takes the
 * surface away. Keyed on the content, so a render that draws the same links says nothing. The
 * surface id is this module's own counter, ASCII as the shell requires, rather than `useId`, whose
 * spelling React has changed between releases. `asks` are the marked links among `hrefs`.
 */
export function useRenderedLinks(hrefs: readonly string[], asks: readonly string[] = []): void {
  const [surface] = useState(() => `links-${++mounts}`);
  const key = hrefs.length === 0 ? "" : JSON.stringify([[...new Set(hrefs)], [...new Set(asks)]]);
  useEffect(() => {
    if (key === "") return undefined;
    const [drawn, asked] = JSON.parse(key) as [string[], string[]];
    reportRenderedLinks(surface, drawn, asked);
    return () => reportRenderedLinks(surface, []);
  }, [surface, key]);
}

/** {@link useRenderedLinks} as an element, for a renderer that collects its links while it draws. */
export function RenderedLinks({ hrefs }: { hrefs: readonly string[] }): null {
  useRenderedLinks(hrefs);
  return null;
}
