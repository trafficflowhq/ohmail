/**
 * ASKING YOUR OWN MODEL ABOUT THE SENDERS WAITING AT THE SCREENER. The hosted control is built
 * around a price; here there is nothing metered — the model is one its user set up — so this
 * control shares everything that is not about money (endpoint, request shape, overlay) and
 * drops the dry run and the price. It KEEPS the ladder: dropping the COUNT with the price left
 * one fixed fifty and no way to ask for three hundred but six presses; the rungs are the
 * hosted ladder's own, over the queue, topping out at ALL of them. Three states, all honest:
 * no model set up, a model not answering (the engine's own sentence), a model that works —
 * never a pressable button with nothing behind it. The asking is `local-suggest-run.ts`.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AskWell, Button, SizeLadder } from "@ohmail/ui";

import { unavailableLine, type LocalAiStatus } from "./local-ai.js";
import {
  hydrateSuggestions,
  runSuggest,
  localBatchSizes,
  lanesFor,
  DEFAULT_PER_PRESS,
  type SuggestionRow,
} from "./local-suggest-run.js";

export interface LocalSuggestProps {
  /** Waiting senders with no suggestion yet, in queue order. */
  senders: string[];
  /** Put answers into the one overlay the rows read their chips from. */
  absorb: (rows: SuggestionRow[]) => void;
  /** What the engine says about this install's model. `null` before the first read has landed. */
  ai: LocalAiStatus | null;
  /** Take the person to the pane where a model is set up. */
  onConfigure: () => void;
}

export function LocalSuggest({ senders, absorb, ai, onConfigure }: LocalSuggestProps) {
  /* See `DesktopScreeningWords` for why `desktopScreener` has to be on `vite.config.ts`'s
     namespace list. Only the three sentences this control owns are read here — the refusal
     sentences below are the ENGINE's own words and are never composed in this file. */
  const t = useTranslations("desktopScreener");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * THE RUNG THE PERSON CHOSE, or `null` while they have not — in which case the resting default
   * stands. Kept as the NUMBER rather than an index into the ladder, because the ladder is derived
   * from a queue that shrinks as answers land: an index would silently point at a different size
   * after every chunk, which is the control changing what a press means while somebody reads it.
   */
  const [size, setSize] = useState<number | null>(null);
  /**
   * `run` counts presses and NOTHING ELSE increments it. It is captured when a run starts and
   * compared on every chunk's arrival, so a stop mid-run discards what is still in flight
   * instead of painting it. Never re-bumped inside the loop: a per-chunk bump makes each chunk
   * invalidate the next one's check — a run that silently cancels itself and leaves the button
   * spinning. `hydrated` latches the one stored read. `busy` latches the press, set BEFORE the
   * first await — set after it, two presses that race both read false and both run.
   */
  const io = useRef({ run: 0, hydrated: false, busy: false });

  /* THE STORED ANSWERS, ONCE. During render rather than in an effect, because this control is
     mounted and unmounted as the Screener comes and goes, and an effect would re-read on every
     visit. The latch is what makes it once per window. A failed read answers with nothing and says
     nothing: the rows are then exactly as they already render, without chips. */
  if (!io.current.hydrated) {
    io.current.hydrated = true;
    void hydrateSuggestions().then((rows) => {
      if (rows.length > 0) absorb(rows);
    });
  }

  if (senders.length === 0) return null;

  if (ai === null) {
    /* The first read has not landed. One quiet line rather than a guess in either direction: a
       control that renders "no model" for a moment on every visit teaches people to ignore it. */
    return <span className="scn-sg-note" role="status">{t("suggestChecking")}</span>;
  }

  const problem = ai.provider === null
    ? t("suggestNoModel")
    : ai.available
      ? null
      : unavailableLine(ai);

  if (problem) {
    /* The well in its refused state: the engine's sentence where the question would be, and the
       one verb that answers it. */
    return (
      <AskWell
        state="refused"
        ariaLabel={t("suggestAria")}
        label={problem}
        actions={<Button variant="ghost" onClick={onConfigure}>{t("suggestSetUp")}</Button>}
      />
    );
  }

  /* THE RUNGS, over what is actually waiting — so the top one is "all 312" and not a number
     larger than the queue. `localBatchSizes` is the hosted control's own ladder function. */
  const sizes = localBatchSizes(senders.length);
  /* The chosen rung, or the resting default — and never larger than the queue, which is what
     makes the button's number true when the queue has shrunk under a stale choice. */
  const total = Math.min(senders.length, size ?? DEFAULT_PER_PRESS);
  /* Where the model runs decides how many requests may be in flight. See `lanesFor`: measured
     to be worth nothing against a daemon on this machine, and worth a great deal against a key. */
  const lanes = lanesFor(ai.contentGoesTo);

  const stop = (): void => {
    io.current.run++;
    io.current.busy = false;
    setRunning(false);
    setNotice(null);
  };

  const start = (): void => {
    if (io.current.busy) return;
    // LATCHED BEFORE THE AWAIT. See the ref's comment.
    io.current.busy = true;
    const run = ++io.current.run;
    const mine = (): boolean => io.current.run === run;
    setRunning(true);
    setNotice(`0 of ${total}`);
    void (async () => {
      try {
        const out = await runSuggest({
          senders,
          limit: total,
          lanes,
          absorb,
          alive: mine,
          onProgress: (done, of) => {
            if (mine()) setNotice(`${done} of ${of}`);
          },
        });
        if (out.abandoned || !mine()) return;
        if (out.refusal) {
          // The ENGINE'S OWN SENTENCE, whatever it is — never a class of failure composed here.
          setNotice(
            out.refusal.noModel
              ? `${out.refusal.message} Set one up under Settings, Desktop.`
              : out.done > 0
                ? `Stopped after ${out.done} of ${out.total}. ${out.refusal.message}`
                : out.refusal.message,
          );
          return;
        }
        setNotice(out.done === 0 ? "Nothing to suggest for these senders." : null);
      } catch (err) {
        if (!mine()) return;
        setNotice(err instanceof Error ? err.message : String(err));
      } finally {
        if (mine()) {
          io.current.busy = false;
          setRunning(false);
        }
      }
    })();
  };

  /* THE SAME WELL the hosted control uses, so a person who has seen one has seen the other:
     the question and its rungs, the status line, the verbs, the sentence at the foot. `working`
     while a run is on — the confirm carries it along its foot and reads "Suggesting…"; the
     status line carries the count. */
  return (
    <AskWell
      state={running ? "working" : "idle"}
      ariaLabel={t("suggestAria")}
      label={t("suggestAsk", { count: total })}
      /* THE RUNGS. Rendered only when there is a choice to make — one rung is not a ladder,
         it is the button's own number said twice. The top rung says "all N" rather than the
         bare figure, because "all of them" is the thing a person with a backlog is looking
         for and a number alone does not say whether it is all of them. */
      ladder={
        sizes.length > 1 ? (
          <SizeLadder
            sizes={sizes}
            value={total}
            disabled={running}
            onChange={setSize}
            labelOf={(n) => (n === senders.length ? t("suggestAll", { count: n }) : n)}
          />
        ) : null
      }
      status={running ? notice : null}
      actions={
        running ? (
          <>
            <Button disabled aria-busy="true" data-run="working">{t("suggestRunning")}</Button>
            {/* STOPS THE RUN, and says no more than that. The request already in flight finishes at
                the engine whatever this does — the transport carries no cancellation — so what this
                actually stops is everything after it. */}
            <Button variant="ghost" onClick={stop}>{t("suggestStop")}</Button>
          </>
        ) : (
          <Button onClick={start}>{t("suggestGo", { count: total })}</Button>
        )
      }
      note={
        running
          ? null
          : notice ?? t("suggestNote")
      }
    />
  );
}
