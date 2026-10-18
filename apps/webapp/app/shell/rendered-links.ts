/**
 * THE LINKS ON SCREEN, TO THE SHELL. The desktop shell opens an http(s) address in the person's
 * browser only when it is a link something in this window drew — a message's anchors (the frame's
 * and the prose path's), the editor's (a draft's, a signature's), the Screener's unsubscribe link,
 * the account page an answer named — or one of the shell's own constant links (`rendered_links.rs`).
 * Each renderer reports what it draws, per mount, through {@link useRenderedLinks}, and the shell
 * keeps a bounded list per surface.
 *
 * A registration, armed by the desktop entry (`apps/desktop/src/main.tsx`) before the first render,
 * and `null` everywhere else: the web app and the served host client report into nothing. This file
 * names no shell command, so a bundle that carries it carries none (`scan-artifact.mjs`).
 */
import { useEffect, useState } from "react";

/** Where a report goes: the shell's list in the desktop window, nowhere elsewhere. */
export type RenderedLinksSink = (surface: string, hrefs: readonly string[]) => void;

let sink: RenderedLinksSink | null = null;

/** Point reports at the shell, or pass `null` to take that away. */
export function setRenderedLinksSink(next: RenderedLinksSink | null): void {
  sink = next;
}

/** Report one surface's links; an empty list removes the surface. Nothing happens with no sink. */
export function reportRenderedLinks(surface: string, hrefs: readonly string[]): void {
  sink?.(surface, hrefs);
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
 * spelling React has changed between releases.
 */
export function useRenderedLinks(hrefs: readonly string[]): void {
  const [surface] = useState(() => `links-${++mounts}`);
  const key = hrefs.length === 0 ? "" : JSON.stringify([...new Set(hrefs)]);
  useEffect(() => {
    if (key === "") return undefined;
    reportRenderedLinks(surface, JSON.parse(key) as string[]);
    return () => reportRenderedLinks(surface, []);
  }, [surface, key]);
}

/** {@link useRenderedLinks} as an element, for a renderer that collects its links while it draws. */
export function RenderedLinks({ hrefs }: { hrefs: readonly string[] }): null {
  useRenderedLinks(hrefs);
  return null;
}
