"use client";

/**
 * WHERE A SCREENING CHANGE WENT, said on the pane that sent it. On an install that organizes none
 * of the account's mailboxes a change is sent to the one that does and nothing is written here,
 * so "Saved." at the press was a claim about a write that never happened, and the holder's answer
 * reached no surface. The pane now says the change is on its way, then "Applied." when the holder
 * acknowledged it, or which install could not take it. The answer rides `change` on the pane's own
 * read (`GET /account/screening`); this re-reads it for a few minutes after a press, as the away
 * row does, and stops.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

/** `change` on the Screening pane's read — see `readProfileChange` on the server. */
export interface TravelledChangeWire {
  state: "asked" | "applied" | "refused";
  holder: string | null;
  refusal: "unreadable" | "other" | null;
}

export type TravelledNote =
  | { kind: "asked" }
  | { kind: "applied" }
  | { kind: "refused"; holder: string | null; refusal: "unreadable" | "other" | null };

/** The organizer's cycle is tens of seconds; a few minutes of asking covers several of them. */
export const CHANGE_POLL_MS = 20_000;
export const CHANGE_POLL_MAX = 12;

interface Answer { pending?: true; change?: TravelledChangeWire }

export function noteOf(change: TravelledChangeWire | undefined): TravelledNote | null {
  if (!change) return null;
  if (change.state === "asked") return { kind: "asked" };
  if (change.state === "applied") return { kind: "applied" };
  return { kind: "refused", holder: change.holder, refusal: change.refusal };
}

/**
 * `heard` takes every answer the pane gets — its first read (`press: false`) and each save's
 * (`press: true`) — and returns whether it has something to say, so a local save can still say
 * "Saved.". A first read shows only what is still true on arrival: a change on its way, or a
 * refusal; an old "Applied." is not news. `reread` is the pane's own read; `onRead` puts its
 * values on screen, because an applied change is shown by the values the holder applied.
 */
export function useTravelledChange<T extends Answer>(opts: {
  reread: () => Promise<T>;
  onRead: (next: T) => void;
}): { note: TravelledNote | null; heard: (answer: T, press: boolean) => boolean; clear: () => void } {
  const [note, setNote] = useState<TravelledNote | null>(null);
  const live = useRef(opts);
  live.current = opts;
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    gen.current += 1;
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => stop, [stop]);

  const watch = useCallback(() => {
    const mine = ++gen.current;
    let left = CHANGE_POLL_MAX;
    const tick = (): void => {
      timer.current = setTimeout(() => {
        void (async () => {
          if (mine !== gen.current) return;
          left -= 1;
          try {
            const next = await live.current.reread();
            if (mine !== gen.current) return;
            live.current.onRead(next);
            const said = noteOf(next.change);
            if (said?.kind !== "asked") { setNote(said); return; }
          } catch {
            /* A read that failed is not an answer about the change; the attempt is spent. */
          }
          if (left > 0) tick();
        })();
      }, CHANGE_POLL_MS);
    };
    tick();
  }, []);

  const heard = useCallback((answer: T, press: boolean): boolean => {
    stop();
    if (press) {
      // Written here: the pane says "Saved." itself.
      if (answer.pending !== true) { setNote(null); return false; }
      setNote({ kind: "asked" });
      watch();
      return true;
    }
    const said = noteOf(answer.change);
    if (said?.kind === "asked") { setNote(said); watch(); return true; }
    if (said?.kind === "refused") { setNote(said); return true; }
    setNote(null);
    return false;
  }, [stop, watch]);

  const clear = useCallback(() => { stop(); setNote(null); }, [stop]);
  return { note, heard, clear };
}

/**
 * What a pane that cannot show the applied value says standing: the change on its way, or its
 * refusal. The dormancy dial and the signature editors read their own row, which a holder's
 * apply does not write, so "Applied." there would sit over the old value.
 */
export function standingNote(change: TravelledChangeWire | null | undefined): TravelledNote | null {
  const note = noteOf(change ?? undefined);
  return note?.kind === "applied" ? null : note;
}

/** The sentence for a {@link TravelledNote}. A live region, so a press's answer is heard. */
export function TravelledChangeNote({ note, className = "scn-sg-note" }: {
  note: TravelledNote | null;
  className?: string;
}) {
  const t = useTranslations("settings");
  if (note === null) return null;
  if (note.kind === "asked") return <span className={className} role="status">{t("screening.asked")}</span>;
  if (note.kind === "applied") return <span className={className} role="status">{t("screening.applied")}</span>;
  const unreadable = note.refusal !== "other";
  const text = note.holder
    ? t(unreadable ? "screening.refusedUnreadable" : "screening.refusedOther", { name: note.holder })
    : t(unreadable ? "screening.refusedUnreadableUnknown" : "screening.refusedOtherUnknown");
  return <span className={className} role="alert">{text}</span>;
}
