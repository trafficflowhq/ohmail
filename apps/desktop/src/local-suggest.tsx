/**
 * ASKING YOUR OWN MODEL ABOUT THE SENDERS WAITING AT THE SCREENER.
 *
 * The hosted client has a control for this and it is built around a price: it asks the server what
 * a set of senders would cost, shows the number, and only then offers a button. That control is
 * correct there and wrong here, and not because the wording is off — because there is nothing for
 * it to describe. A standalone install has no account, no balance and nothing metered. The model is
 * one its owner set up, under their own key or on their own machine, so what a run costs is between
 * them and their provider. A ladder of sizes priced in something this app does not sell would be an
 * invented number standing in front of a real one.
 *
 * So this is a different control for a different question, sharing everything that is not about
 * money: the same endpoint, the same request shape, the same overlay the rows read their chips
 * from. What it drops is the dry run and the price. What it adds is the one thing the hosted
 * client never has to say — that there may be no model at all.
 *
 * ── IT KEEPS THE LADDER, WHICH IT USED TO DROP TOO, AND THAT WAS THE DEFECT ─────────────────
 *
 * Dropping the PRICE is right. Dropping the COUNT was not, and the two went together because the
 * hosted ladder is a ladder of prices. This control offered one fixed number — fifty — so a person
 * with three hundred senders waiting read "Suggest for 50 senders", every time, with no way to ask
 * for the rest except to press again six times and no indication that was the intent. The reason
 * recorded for the fifty was that a bigger press "would be a buy ladder without the number that
 * made one honest"; there is nothing bought here, and the number that makes a press honest on this
 * door is simply how many senders it will ask about. So the rungs come back — the hosted ladder's
 * own, over the queue instead of over a price, topping out at ALL of them.
 *
 * ── NEVER A CONTROL WITH NOTHING BEHIND IT ──────────────────────────────────────────────────
 *
 * Three states and all three are honest. No model set up: it says so and points at the pane that
 * fixes it. A model set up that is not answering: the engine's own sentence about why, and the same
 * way out. A model that works: one button, naming exactly how many senders it will ask about. There
 * is no fourth state where a button is pressable and nothing can happen — which is what this
 * surface was before, for the whole life of the local-engine build.
 *
 * The asking itself is `local-suggest-run.ts`, which has no React in it and is proven against a
 * real engine. What is here is the three states and the press.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

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
   * `run` counts presses and NOTHING ELSE increments it.
   *
   * It is captured once when a run starts and compared on the arrival of every chunk, so a stop
   * mid-run discards what is still in flight instead of painting it. It is deliberately never
   * re-bumped inside the loop: a per-chunk bump makes each chunk invalidate the next one's check,
   * which is a run that silently cancels itself and leaves the button spinning for ever.
   *
   * `hydrated` latches the one stored read. `busy` latches the press, and it is set BEFORE the
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
    return (
      <div className="scn-suggest" role="group" aria-label="Suggestions">
        <span className="scn-sg-note">{problem}</span>
        <Button variant="ghost" onClick={onConfigure}>{t("suggestSetUp")}</Button>
      </div>
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

  return (
    <div className="scn-suggest" role="group" aria-label="Suggestions">
      {running ? (
        <>
          <span className="scn-sg-price num" role="status">{notice}</span>
          {/* STOPS THE RUN, and says no more than that. The request already in flight finishes at
              the engine whatever this does — the transport carries no cancellation — so what this
              actually stops is everything after it. */}
          <Button variant="ghost" onClick={stop}>Stop</Button>
        </>
      ) : (
        <>
          {/* THE RUNGS. Rendered only when there is a choice to make — one rung is not a ladder,
              it is the button's own number said twice. The top rung says "all N" rather than the
              bare figure, because "all of them" is the thing a person with a backlog is looking
              for and a number alone does not say whether it is all of them. */}
          {sizes.length > 1 ? (
            <div className="scn-sg-sizes">
              {sizes.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={n === total ? "scn-sg-size on" : "scn-sg-size"}
                  aria-pressed={n === total}
                  onClick={() => setSize(n)}
                >
                  {n === senders.length ? `all ${n}` : n}
                </button>
              ))}
            </div>
          ) : null}
          <Button onClick={start}>
            {total === 1 ? "Suggest for 1 sender" : `Suggest for ${total} senders`}
          </Button>
          <span className="scn-sg-note">
            Uses the model you set up. Senders already answered for are not asked about again.
          </span>
          {notice ? <span className="scn-sg-note" role="status">{notice}</span> : null}
        </>
      )}
    </div>
  );
}
