"use client";

/**
 * "Link the desktop app" — the ceremony cut from `LinkDesktopScreen` word for word: mint a one-use code at the press
 * (never on load), show it, and let it die on screen at the SERVER's `expiresIn`. The mint is step-up gated: it is
 * TRIED first, a closed window opens the factor in place, and the verified factor retries the mint once, the
 * commitment with it. Nothing here signs in. The page settles whose browser this is before it offers a code.
 */

import { useEffect, useRef, useState } from "react";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { useTranslations } from "next-intl";
import { apiConfigured, auth } from "../../api-client";
import { isBusy, retryBusy } from "../../retry-busy";
import { gatedRefusal } from "../mailbox/gated-refusal";
import { useRefusalSentence } from "../refusal-sentence";
import { isOwnerAbsent, useSettledOwner, type Settled } from "../approve/settle-owner";

/** A live code and the moment it stops being one. */
export interface Minted {
  code: string;
  expiresAtMs: number;
}

/** `idle` is the mint button (or the code, once one exists); `stepup` is the prompt a closed window opens. */
export type Phase = "idle" | "stepup";

/** What the link's ceremony holds and does: exactly what its page reads. */
export interface LinkDesktopCeremony {
  settled: Settled;
  minted: Minted | null;
  remaining: number;
  busy: boolean;
  error: string | null;
  phase: Phase;
  /** Signing in is the remedy: the mint was refused with a dead session or after a verified factor. */
  signIn: boolean;
  /** A factor landed after the prompt's Cancel and was discarded: no code was minted. */
  discarded: boolean;
  retryAt: number | null;
  retryIn: number;
  /** During a busy wait the button retries now; otherwise it mints. */
  press(): void;
  stepUpVerified(): void;
  stepUpCancelled(): void;
  stepUpDiscarded(): void;
  stepUpOwnerAbsent(): void;
}

export function useLinkDesktopDoor(commitment: string): LinkDesktopCeremony {
  /**
   * THIS PAGE ACTS ON AN ACCOUNT, SO IT IS NOT A PUBLIC SURFACE: A fresh `/link-desktop` load left the Cloud client
   * `public`, which permits every request. The sequence review walked: the page is opened under A, another tab
   * establishes B, and pressing the button mints and RENDERS a one-use pairing credential for B — on a screen whose
   * whole job is to show a credential to whoever is looking at it. `pendApiOwner` during render, for `CloudShell`'s
   * reason: an effect runs after the commit that mounted the button, and the press can come first. It never widens,
   * so a confirmed shell keeps its binding and a refused sign-out keeps its block.
   */
  pendApiOwner(readOwner());
  const t = useTranslations("linkDesktop");
  const refusalSentence = useRefusalSentence();
  const { settled, resettle } = useSettledOwner(apiConfigured());

  const [minted, setMinted] = useState<Minted | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Whether the step-up prompt is up. `idle` means it is not. */
  const [phase, setPhase] = useState<Phase>("idle");
  /** Signing in is the remedy: the mint was refused with a dead session or after a verified factor. */
  const [signIn, setSignIn] = useState(false);
  /** A factor landed after the prompt's Cancel and was discarded — no code was minted, and it is said. */
  const [discarded, setDiscarded] = useState(false);

  /** The page can be navigated away from mid-flight; nothing may set state after that. */
  const alive = useRef(true);
  /** Ends a busy wait on unmount, so no mint runs for a page nobody is looking at. */
  const gone = useRef(new AbortController());
  useEffect(() => () => { alive.current = false; gone.current.abort(); }, []);

  /**
   * A BUSY SERVER IS A WAIT, NOT A DEAD END. While `retryBusy` waits out a 503 `db_busy`, the page
   * says so with a countdown and keeps its button live: a press ends the wait and retries now.
   * `retryAt` is when the next ask goes out; `wake` ends the current wait early.
   */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const wake = useRef<(() => void) | null>(null);
  const sleepOrPress = (ms: number): Promise<void> => new Promise((resolve) => {
    // The wait is over either way: the retry that follows is in flight, so the button is not live.
    const done = (): void => {
      clearTimeout(timer); wake.current = null;
      if (alive.current) setRetryAt(null);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake.current = done;
  });
  useEffect(() => {
    if (retryAt === null) return;
    const tick = (): void => setRetryIn(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryAt]);

  /** `afterFactor`: this is the retry a verified factor runs, so a second closed window is a sentence. */
  const mint = (afterFactor = false): void => {
    setBusy(true);
    setError(null);
    setSignIn(false);
    setDiscarded(false);
    setPhase("idle");
    void (async () => {
      try {
        // The commitment travels with every mint on this page, including the one retried after a
        // step-up ceremony — a retry that dropped it would silently hand back an UNBOUND code to
        // an app that is still holding a verifier, and the handoff would fail with nothing on
        // either screen saying why.
        // `replaySafe`: a busy mint may have written a code nobody saw; it is one-use, bound to
        // the same challenge and expires unspent, so asking again costs nothing.
        const { code: minted, expiresIn } = await retryBusy(
          () => auth.desktopLink({ challenge: commitment }),
          {
            replaySafe: true,
            signal: gone.current.signal,
            sleep: sleepOrPress,
            onWait: (ms) => {
              if (!alive.current) return;
              setPhase("idle");
              setRetryIn(Math.max(1, Math.ceil(ms / 1000)));
              setRetryAt(Date.now() + ms);
            },
          },
        );
        if (!alive.current) return;
        setMinted({ code: minted, expiresAtMs: Date.now() + expiresIn * 1000 });
        setRemaining(expiresIn);
        setPhase("idle");
      } catch (err) {
        if (!alive.current) return;
        if (isOwnerAbsent(err)) { resettle(); return; }
        const why = gatedRefusal(err, afterFactor);
        if (why === "factor") {
          setPhase("stepup");
        } else if (why === "sign-in") {
          setSignIn(true);
        } else if (isBusy(err)) {
          // The server, never the session: the sign-in is fine and the button is still there.
          setError(t("busyGaveUp"));
        } else {
          setError(refusalSentence(err));
        }
      } finally {
        if (alive.current) { setBusy(false); setRetryAt(null); }
      }
    })();
  };

  /* The countdown, and the removal at zero. One interval, cleared on unmount and whenever a new
     code replaces the old one — a leaked interval here would keep writing state into a page
     somebody has left. */
  useEffect(() => {
    if (!minted) return;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((minted.expiresAtMs - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setMinted(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [minted]);

  /** During a busy wait the button stays pressable and retries now; otherwise it mints. */
  const press = (): void => { if (wake.current) wake.current(); else mint(); };
  return {
    settled, minted, remaining, busy, error, phase, signIn, discarded, retryAt, retryIn, press,
    stepUpVerified: () => mint(true),
    stepUpCancelled: () => setPhase("idle"),
    stepUpDiscarded: () => setDiscarded(true),
    stepUpOwnerAbsent: () => { setPhase("idle"); resettle(); },
  };
}
