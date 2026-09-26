"use client";

/**
 * WHICH OPEN CARDS CARRY THE VERB BAR — the last one opened, plus any earlier holder still on
 * screen. The bar leaving a card changes that card's height, and a card on screen above the one
 * just opened moved every row with it by the bar's height (43–78px, measured in Chromium). So the
 * bar leaves a still-open card only once that card is out of the port, where the stream's hold
 * loop absorbs the change; a close takes it at once — the close is the reader's own gesture.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useMessageChrome } from "./message-chrome";
import type { StreamHandle } from "./StreamShell";

const NONE: ReadonlySet<string> = new Set();

export interface StreamBar {
  /** Does this card draw the verb bar? */
  hasBar: (id: string) => boolean;
  /** The card's toggle, called from the press — before React commits the change. */
  toggled: (id: string, open: boolean) => void;
}

export function useStreamBar(stream: RefObject<StreamHandle | null>): StreamBar {
  const [holder, setHolder] = useState<string | null>(null);
  const [lingering, setLingering] = useState<ReadonlySet<string>>(NONE);
  /* The press reads the holder synchronously, and two presses can land inside one commit. */
  const holderRef = useRef<string | null>(null);

  const release = useCallback((id: string) => {
    setLingering((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }, []);

  const toggled = useCallback((id: string, open: boolean) => {
    const prev = holderRef.current;
    if (open) {
      const handle = stream.current;
      if (prev && prev !== id && handle?.onScreen(prev)) {
        setLingering((s) => new Set(s).add(prev));
        handle.whenOffScreen(prev, () => release(prev));
      }
      holderRef.current = id;
      setHolder(id);
      release(id);
      return;
    }
    // Closing takes the bar only if it is THIS card's — opening B never collapses A.
    if (prev === id) {
      holderRef.current = null;
      setHolder(null);
    }
    release(id);
  }, [stream, release]);

  const hasBar = useCallback((id: string) => id === holder || lingering.has(id), [holder, lingering]);
  return { hasBar, toggled };
}

/**
 * A STRIP THE SHELL OPENED BY KEY LANDS ON THE CARD THE KEY NAMED. `m`, `d` and `b` open their
 * panel on the stream's cursor, while the bar follows the card last opened — so the cursor's card
 * could hold no bar and the key opened a strip nobody could see. That card is opened here the way
 * a click opens it (the view's one definition of open), and its bar then shows the strip.
 */
export function useKeyPanelOpensCard(
  view: string, hasBar: (id: string) => boolean, holds: (id: string) => boolean,
): void {
  const id = useMessageChrome().barPanel?.messageId ?? null;
  const ask = useRef({ hasBar, holds });
  ask.current = { hasBar, holds };
  useEffect(() => {
    if (id === null || ask.current.hasBar(id) || !ask.current.holds(id)) return;
    document.querySelector<HTMLElement>(`${view} .scast[data-sid="${CSS.escape(id)}"]`)?.click();
  }, [id, view]);
}
