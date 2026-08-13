"use client";

/**
 * Screener — the fourth two-pane view: waiting senders as rows on the
 * left, the sender's actual held mail on the right under the sticky
 * decision bar. One click files; each ✓ half files and marks read; the
 * AI destination is preselected so y accepts it. Screened-out senders
 * stay reversible; auto-detected spam is held viewable, never deleted
 * silently. On mobile the preview opens full-screen.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  BodyState,
  ScreenerSenderDTO,
  UnsubscribeHeaderState,
  UnsubscribeResult,
} from "@ohmail/client-engine";
import {
  Button,
  Chip,
  DecisionBar,
  DECISION_DONE_LABEL,
  DECISION_KEY,
  DECISION_QUIET,
  Icon,
  Kbd,
  ListPane,
  ListRows,
  MessageRow,
  ProtectedBlock,
  SegmentedControl,
  type DecisionDestination,
  type DecisionScope,
} from "@ohmail/ui";
import { messageOf } from "../api-client";
import { avatarHue } from "../shell/format";
import { displayAddress, displayAddressee, displayAddressUnder, displayDomainLabel } from "../shell/idn";
import { useLoadingGrace } from "../shell/loading-grace";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { ShortcutHint } from "../shell/ShortcutHint";
/* The reader surfaces' own bound on "still coming" — one mechanism, not a second one shaped like
   it. See {@link useBodyStalled} for why the deadline is derived from the engine's rather than
   picked, and `HeldMail` below for why this pile needs it too. */
import { useBodyStalled } from "../shell/message-chrome";
import { goScreener, type ScreenerSegmentId } from "../shell/routing";
import { APPLY_PILE_ORDER } from "../shell/screener-state";
import type { HeldBodyStall, ScreenerState, SpamRow } from "../shell/screener-state";
import type { SuggestBatchControl } from "../shell/screener-suggest";
import type { RemoteImagesChrome } from "../shell/remote-images";
import { MessageBody } from "../components/MessageBody";

/**
 * The copy key that NAMES each pile, so the apply control can say where mail is about to go.
 *
 * A table and not `t(\`pile${dest}\`)`: the destinations are a union, and an interpolated key is
 * a lookup a compiler cannot check — a sixth destination would render the literal string
 * `screener.pileWhatever` into a button rather than failing to build.
 */
const PILE_KEY: Record<DecisionDestination, string> = {
  ohbox: "pileOhbox",
  reads: "pileReads",
  receipts: "pileReceipts",
  screened: "pileScreened",
  spam: "pileSpam",
};

/**
 * "Reads & Receipts" — the piles an apply would file into, as one phrase.
 *
 * The final conjunction goes through `pileJoin` rather than a hard-coded `" & "` because it is
 * the one part of this that is not a list separator: several languages join the last pair with a
 * word, and a literal ampersand here would be untranslatable punctuation baked into a component.
 * Everything before the last pair is a plain comma, which every locale this ships in agrees on.
 *
 * Never empty: the control that calls it is rendered only when `suggestedCount > 0`, and those
 * rows are where the list comes from.
 */
function pileList(dests: DecisionDestination[], t: (k: string, v?: Record<string, string>) => string): string {
  const names = dests.map((d) => t(PILE_KEY[d]));
  if (names.length <= 1) return names[0] ?? "";
  const last = names[names.length - 1]!;
  const head = names.slice(0, -1);
  return t("pileJoin", { a: head.join(", "), b: last });
}

/**
 * THE SIX GROUPS A WAITING QUEUE FALLS INTO — the filter chips, in the order they are offered.
 *
 * Spelled as {@link APPLY_PILE_ORDER} plus the one group the bulk apply REFUSES, because that is
 * the whole point of the row. "Apply 12 — Ohbox, Reads & Receipts" over a queue of 47 is a true
 * sentence that leaves 35 senders unaccounted for, and a reader has no way to find out where
 * they went: the button names what it will do and says nothing about what it is stepping over.
 * The chips are that remainder, made countable — `none`, which is every sender the model held,
 * could not answer for, or was never asked about.
 *
 * `spam` USED TO BE LISTED HERE SEPARATELY, and it moved into `APPLY_PILE_ORDER` rather than being
 * dropped: the apply now files spam like every other verdict, so it is one of the piles the button
 * names instead of one of the groups it steps over. Its chip is unchanged and sits in the same
 * place, which is the point of deriving this list rather than hand-keeping it.
 *
 * Deriving the piles from the shared constant is what keeps the chips and the banner describing
 * ONE set: a new destination, or a change of order, moves both at once. Two hand-kept lists would
 * drift, and the drift would read as the apply count being wrong.
 */
const FILTER_ORDER = [...APPLY_PILE_ORDER, "none"] as const;
type ScreenerFilterId = DecisionDestination | "none";

/** Breathing room above the anchored message, so its own header is not flush with the column edge. */
export const HELD_ANCHOR_PAD_PX = 14;

/**
 * WHERE THE READ COLUMN MUST SCROLL TO PUT THE LAST HELD MESSAGE AT THE TOP.
 *
 * Held mail renders oldest→newest, so a fresh render sits on the OLDEST message while the decision
 * a person is about to take is about the newest. All three terms are load-bearing and the
 * two-term versions are both plausible:
 *
 *  · `lastTop - readTop` is the message's offset from the column's VIEWPORT edge, not from the
 *    column's content origin. Used alone it is correct only from `scrollTop === 0`, and from
 *    anywhere else it scrolls by a delta instead of to a position — which is what happens on every
 *    selection change after the first, because the previous sender left the column scrolled.
 *  · `+ scrollTop` converts that viewport offset into a content offset. This is the term a
 *    plausible-looking rewrite drops.
 *  · `- pad` is the gap above the message. Clamped at 0, because the first message in a short list
 *    yields a negative target and a negative `scrollTop` is silently coerced to 0 by the DOM —
 *    correct by accident, and this makes it correct on purpose.
 *
 * Pure, and taking numbers rather than elements, because jsdom reports every
 * `getBoundingClientRect` as zero: an assertion made against a MOUNTED view cannot tell this
 * formula from a wrong one, so the guard has to drive the arithmetic directly.
 *
 * ── THE LIMIT THIS DOCBLOCK USED TO NAME IS NOW CLOSED, AND IT WAS WORSE THAN "COLD" ─────────
 *
 * It read: the effect runs once per `[activeId, segment]`, which is right for a WARM mirror and
 * leaves a COLD one anchored against snippets that then grow — and that re-anchoring "needs a
 * scroll-intent signal this view does not have".
 *
 * The diagnosis was exactly right; the scope was too kind. "Cold" suggests a first run, and this is
 * not about warm-up: a DERIVED row's body is a snippet EVERY time the sender is selected. `bodyOf`
 * answers `full` only from a body it already holds — an inline `m.body`, or a stored `message_body`
 * record — so wherever bodies are fetched on demand the entries begin short and grow. The anchor
 * therefore landed correctly only where the rows carry their bodies inline (the demo world's shape,
 * `m.body !== undefined`, final height from the first render) and put the reader inside the OLDEST
 * message everywhere else. Three snippets at ~100px anchor at 186px; the same three hydrated are
 * ~600px each, so 186px is inside the first card.
 *
 * The signal turned out not to need a listener. The caller now remembers the position it last
 * WROTE ({@link ANCHOR_TOLERANCE_PX}) and re-anchors only while the scroller is still there, so a
 * reader who scrolled owns the column and a body landing does not yank them — the promise the old
 * dependency list was keeping, kept without giving up the anchor. See the effect, and
 * `screener-latest-anchor.test.tsx`, which models the growth because jsdom reports no layout.
 */
export function heldAnchorTop(
  readTop: number, lastTop: number, scrollTop: number, pad = HELD_ANCHOR_PAD_PX,
): number {
  return Math.max(0, lastTop - readTop + scrollTop - pad);
}

/**
 * How far the read column may have drifted from where the latest-message anchor last put it and
 * still count as "the reader has not touched it".
 *
 * Two pixels rather than zero because a browser reports a FRACTIONAL `scrollTop` under a fractional
 * device pixel ratio, and clamps it to the scrollable range — so an exact comparison would read the
 * anchor's own write as somebody else's scroll on the very next pass and stop re-anchoring, which is
 * the defect this tolerance exists inside the fix for. Small enough that any deliberate scroll (a
 * wheel notch is tens of pixels) is outside it.
 */
const ANCHOR_TOLERANCE_PX = 2;

/**
 * Which chip a waiting row belongs to.
 *
 * A hold (`dest: "screener"`, the model declining to place this sender), a `noAnswer` (it was
 * never asked, or the run ran out) and a row nobody has bought advice for are ONE group here,
 * and deliberately: they differ in why, which the row chip and the preview already say, but not
 * in what a reader has to do about them. All three are senders still waiting on a person.
 */
function filterGroupOf(w: ScreenerSenderDTO): ScreenerFilterId {
  const ai = w.ai;
  if (!ai || ai.noAnswer || ai.dest === "screener") return "none";
  return ai.dest;
}

/**
 * THE DESTINATION A ROW'S ACCEPT WOULD FILE TO — null when there is nothing to accept.
 *
 * The same predicate the Enter binding uses, and it must stay the same one: a row that offers a
 * one-press accept while Enter refuses it (or the reverse) is two answers to "is there a
 * suggestion here". `screener` is the model declining to place the sender and `noAnswer` is it
 * never having answered; an accept control on either would be a button whose only meaning is
 * "accept the decision not to decide".
 */
function acceptDestOf(w: ScreenerSenderDTO): DecisionDestination | null {
  const ai = w.ai;
  if (!ai || ai.noAnswer || ai.dest === "screener") return null;
  return ai.dest;
}

/**
 * THE FILTER CHIPS — the waiting queue, partitioned and counted.
 *
 * Counted over the SAME rows `suggestedCount` is counted over (waiting minus everything already
 * decided), so the four apply-able chips add up to the number on the apply button. They are read
 * off one array in one pass rather than re-derived per chip, which is the only way that identity
 * survives someone editing one of them later.
 *
 * ── WHAT IS NOT OFFERED ────────────────────────────────────────────────────────────────────
 *
 * A chip with nothing in it. Pressing it would empty the pane, and an empty pane under a pressed
 * chip is indistinguishable from an empty queue — the same inert-control lie the apply button is
 * gated against one control over. And with only one non-empty group there is no partition to
 * make: the chip would filter the list to itself, so the whole row stays away.
 */
function FilterChips({
  counts,
  value,
  onChange,
}: {
  counts: Record<ScreenerFilterId, number>;
  value: ScreenerFilterId | null;
  onChange: (next: ScreenerFilterId | null) => void;
}) {
  const t = useTranslations("screener");
  const shown = FILTER_ORDER.filter((id) => counts[id] > 0);
  if (shown.length < 2) return null;
  const total = shown.reduce((n, id) => n + counts[id], 0);
  return (
    <div className="scn-chips" role="group" aria-label={t("filterAria")}>
      <button
        type="button"
        className={value === null ? "scn-chip on" : "scn-chip"}
        aria-pressed={value === null}
        onClick={() => onChange(null)}
      >
        {t("filterAll")} <span className="num">{total}</span>
      </button>
      {shown.map((id) => (
        <button
          key={id}
          type="button"
          /* `off` marks the two the apply button steps over. It is the reason this row exists,
             so it is a difference a reader can see and not only one they can count. */
          className={[
            "scn-chip",
            value === id ? "on" : null,
            id === "spam" || id === "none" ? "off" : null,
          ]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={value === id}
          onClick={() => onChange(value === id ? null : id)}
        >
          {id === "none" ? t("filterNone") : t(PILE_KEY[id])}{" "}
          <span className="num">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A PROGRESS TRACK OVER A SENTENCE THAT IS ALREADY ON SCREEN.
 *
 * Both bulk paths here — buying suggestions, applying them — publish their progress as two
 * numbers beside the sentence that states them, never as a string to be parsed back (see
 * `SuggestBatchControl.progress`). This renders the pair and nothing else.
 *
 * `aria-hidden`, and that is not an oversight: the sentence beside it is in a `role="status"`
 * and is already announced. A labelled `<progress>` would announce the same fact a second time,
 * once as prose and once as a percentage, which is how a screen reader user ends up hearing a
 * bulk run narrated twice per chunk.
 *
 * NEVER RENDERED WITHOUT BOTH NUMBERS. `total` of 0 would put `NaN%` in the accessibility tree
 * and an indeterminate bar on screen — a run that claims to be in flight forever — so a track
 * with no denominator is no track.
 */
function BulkProgress({ done, total }: { done: number; total: number }) {
  if (!(total > 0)) return null;
  return <progress className="scn-prog" aria-hidden="true" value={done} max={total} />;
}

/**
 * ASKING FOR SUGGESTIONS — the control that names the cost before it spends.
 *
 * Every part of this is the same rule stated once: nothing here moves a credit until a person
 * has read a number and pressed a button underneath it. So the price is on screen BEFORE the
 * confirm exists, the confirm is disabled while the price is unknown, and changing how many
 * senders to cover re-asks the server rather than multiplying anything locally.
 *
 * The batch is bounded because the alternative is not. A backlogged mailbox holds hundreds of
 * first-time senders; "suggest for all of them" behind one press is a spend nobody can picture
 * in advance. Sizes come from the state, already clamped to what one request may carry, and
 * the largest is always "everything you could buy in one go" so the common case is one press.
 *
 * ── AND IT DOES NOT VANISH WHEN THERE IS NOTHING LEFT TO BUY ──────────────────────────────
 *
 * This function began `if (control.available === 0) return null`, which is the hide the whole
 * of the AI surface used on a worked queue: an account with 74 answered senders and none
 * outstanding had no suggest control, no mention of suggestions, nothing — indistinguishable
 * from a build where the feature was never wired up. The chips and the apply banner were still
 * there, but they act on advice; nothing on screen said where advice comes from or that this
 * account had already got all of it.
 *
 * So the empty buy list now RESTS rather than disappears. It states the number of senders that
 * have an answer, and it offers the one action that is still true — asking again — which is the
 * same ladder, the same dry run and the same confirm, over the other half of the queue.
 *
 * The only case that still renders nothing is nothing to buy AND nothing to re-ask, which is an
 * empty gate. The list beside this already says "No one's waiting."; a sentence here about zero
 * senders having zero suggestions would be a second, worse way to say it.
 *
 * ── EXPORTED, FOR THE ONE HOST THAT BRINGS ITS OWN CONTROL BUT NOT ITS OWN LADDER ───────────
 *
 * The desktop app hands a node in through this view's `suggestNode` prop, and what that node
 * contains depends on which door the install came in by. A standalone install spends nothing and
 * has its own, wordless control. An install pointed at a hosted account spends that account's
 * allowance, so it is buying the same thing this ladder buys, over a pipe instead of a socket —
 * and rendering a second ladder for it would be a second place for a price to be shown that a
 * purchase does not honour. So it renders THIS one, over a {@link SuggestBatchControl} built by the
 * shared hook with a transport of its own. Nothing about the control changes; only how it asks.
 */
export function SuggestControl({ control }: { control: SuggestBatchControl }) {
  const t = useTranslations("screener");
  const again = control.mode === "again";
  if (control.available === 0 && control.resuggestable === 0) return null;

  if (control.phase === "closed") {
    return (
      <div className="scn-sg-rest">
        {control.available === 0 ? (
          // THE RESTING STATE — a fact, not a control. `role="status"` because it replaces a
          // button in place when the last sender is answered for, and a surface that changes
          // from an action to a sentence under a keyboard user's cursor has to say so.
          <span className="scn-sg-all" role="status">
            {t("suggest.allSuggested", { count: control.resuggestable })}
          </span>
        ) : (
          <Button variant="ghost" onClick={control.open}>
            {t("suggest.open")}
          </Button>
        )}
        {/* Offered whenever there is anything to ask about again — beside the buy control while
            the queue is mixed, alone once it is worked through. Its own affordance and not a
            branch of the one to its left, for the reason the buy and apply controls are separate:
            they are different acts. Pressing it enters the same quote → confirm → progress flow,
            so nothing here can spend before the server has named a figure. */}
        {control.resuggestable > 0 ? (
          <Button variant="ghost" onClick={control.openAgain}>
            {t("suggest.again")}
          </Button>
        ) : null}
      </div>
    );
  }

  const busy = control.phase === "pricing" || control.phase === "running";
  return (
    <div
      className="scn-suggest"
      role="group"
      aria-label={t(again ? "suggest.ariaAgain" : "suggest.aria")}
    >
      <span className="scn-sg-lab">{t(again ? "suggest.labelAgain" : "suggest.label")}</span>
      <div className="scn-sg-sizes">
        {control.sizes.map((n) => (
          <button
            key={n}
            type="button"
            className={n === control.size ? "scn-sg-size on" : "scn-sg-size"}
            aria-pressed={n === control.size}
            disabled={control.phase === "running"}
            onClick={() => control.choose(n)}
          >
            {/* `pool` and not `available`: the top of a re-ask ladder is "all 74 of the senders
                that already have an answer", and read off the buy list that label would be
                attached to the wrong number or to no size at all. */}
            {n === control.pool ? t("suggest.sizeAll", { count: n }) : n}
          </button>
        ))}
      </div>
      {/* THE PRICE, AND ONLY EVER THE SERVER'S. `quote` is what a dry run over this exact
          sender set answered; while it is null there is no number to show and no confirm to
          press. A count multiplied by a credit cost held in this file would be a second
          implementation of who is eligible, quoting one figure while the purchase bought
          another. */}
      <span className="scn-sg-price num" role="status">
        {control.phase === "pricing"
          ? t("suggest.pricing")
          : control.phase === "running"
            ? t("suggest.running")
            : control.quote
              ? t("suggest.price", {
                  senders: control.quote.senders,
                  credits: control.quote.credits,
                })
              : ""}
      </span>
      <Button
        disabled={busy || !control.quote || control.quote.senders === 0}
        onClick={control.confirm}
      >
        {/* THE SERVER'S COUNT WHEN THERE IS ONE, the chosen size only while the price is still
            unknown — and the button is unpressable in exactly that window. A label built from
            `size` alone would say "Suggest for 25 senders" over a quote of 12, which is the
            control naming one number and spending against another.

            On the re-ask that gap is the ordinary case rather than a race: the server prices only
            what it is not already holding, so a ladder of 74 routinely quotes 3. "Suggest again
            for 3 senders" over a chosen 74 is the truth — those three are the ones with new mail,
            and the other 71 answer from what was already bought. */}
        {t(again ? "suggest.confirmAgain" : "suggest.confirm", {
          n: control.quote?.senders ?? control.size,
        })}
      </Button>
      <Button variant="ghost" disabled={control.phase === "running"} onClick={control.cancel}>
        {t("suggest.cancel")}
      </Button>
      {/* Whatever the server said, verbatim — an empty balance, AI switched off, no model
          connected on this deployment. Each is a different, actionable fact and none of them
          is inferable from a status code. */}
      {control.notice ? (
        <span className="scn-sg-note" role="status">
          {control.notice}
        </span>
      ) : null}
      {/* HOW FAR THE PURCHASE HAS GOT, as a track under the sentence that says it in words.
          A chosen size larger than one request is bought as several chunks, so a 40-sender
          press is several round trips and the only evidence of the middle ones was a number
          in a sentence changing. Read straight off `control.progress` — the field the hook
          publishes beside the notice, from the same two sources — and absent in every phase
          but `running`, which is why a finished run leaves no bar behind. */}
      {control.progress ? (
        <BulkProgress done={control.progress.done} total={control.progress.total} />
      ) : null}
    </div>
  );
}

/**
 * QUICK-ADJUST — the decision, on the row, without opening the sender.
 *
 * The Screener's decisions have always lived in the bar above the PREVIEW, which means every
 * sender costs a selection before it costs a decision. On a queue of seventy that is seventy
 * round trips through a reading pane to file mail whose destination the list already names.
 * This is the same decision taken where it is already legible.
 *
 * ── IT ADDS NOTHING TO THE DECIDE PATH, AND THAT IS THE POINT ───────────────────────────────
 *
 * Every control here calls `ScreenerState.decide` — the one funnel. So a row press gets the
 * undo window, the delayed commit, the read clamp on the demoting piles, the rule promotion,
 * and the past-the-gate branch that files with a rule and capped moves instead of a decide,
 * all of them, because it is not a second implementation of filing. A row control that reached
 * for `engine.mutate` directly would look identical on screen and quietly drop all six.
 *
 * ── AND IT ACCEPTS ONLY WHAT THERE IS TO ACCEPT ─────────────────────────────────────────────
 *
 * `accept` is present exactly when {@link acceptDestOf} names a destination. A held sender, a
 * `noAnswer`, and a sender nobody bought advice for get the five destinations and no accept —
 * there is no suggestion to take, and a ✓ over one would be the row claiming an answer the
 * model refused to give.
 */
function RowActions({
  accept,
  open,
  onOpen,
  onFile,
  exiting,
}: {
  /** The suggested destination, or null when there is nothing to accept. */
  accept: DecisionDestination | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onFile: (dest: DecisionDestination) => void;
  /**
   * This row has been decided and is animating away.
   *
   * Rendered as NULL rather than by dropping `MessageRow`'s `actions` prop: dropping it changes
   * the element tree around the row button, which remounts the button and cuts the exit
   * animation off at the first frame. The slot stays, and empties.
   */
  exiting: boolean;
}) {
  const t = useTranslations("screener");
  if (exiting) return null;
  return (
    <>
      {accept ? (
        <button
          type="button"
          className="scn-act scn-act-yes"
          /* The visible word is short because the row already says WHERE — the suggestion chip
             is one line above it. The accessible name is not allowed that context: a screen
             reader user arriving on this button hears it alone, so it names the pile. */
          aria-label={t("rowAcceptAria", { dest: DECISION_DONE_LABEL[accept] })}
          title={t("rowAcceptAria", { dest: DECISION_DONE_LABEL[accept] })}
          onClick={() => onFile(accept)}
        >
          {t("rowAccept")}
        </button>
      ) : null}
      <button
        type="button"
        className="scn-act scn-act-more"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("rowMoreAria")}
        title={t("rowMoreAria")}
        onClick={() => onOpen(!open)}
      >
        <Icon name="chev" className="chev" />
      </button>
      {open ? (
        <div className="scn-act-menu" role="menu" aria-label={t("rowMoreAria")}>
          {(["ohbox", "reads", "receipts", "screened", "spam"] as DecisionDestination[]).map((d) => (
            <button
              key={d}
              type="button"
              role="menuitem"
              className="scn-act-dest"
              onClick={() => onFile(d)}
            >
              {t(PILE_KEY[d])} <Kbd>{DECISION_KEY[d]}</Kbd>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The three empty states.
 *
 * The copy used to be read from `@ohmail/fixtures` and rendered on every account, demo or not.
 * It happened to be brand-neutral English, so nobody noticed — but the defect is the import,
 * not the wording: the fixtures package is Mila's world, it is the ONE place in this repo where
 * invented people and invented brands are allowed to live, and a live surface reading strings
 * out of it has no way to stay honest as those strings change. It is app copy, so it lives with
 * the app's copy. `demo-zero-network.test.ts` now forbids the import class outright.
 */
function Empty({ segment, settled }: { segment: ScreenerSegmentId; settled: boolean }) {
  const t = useTranslations("screener");
  const speak = useLoadingGrace(!settled);
  /**
   * ── "No one's waiting." IS A FACT ABOUT SENDERS, NOT ABOUT THIS LIST ──────────────────
   *
   * This pane was caught claiming nobody was waiting — 0 rows, meta "all clear" — on a mailbox
   * that was holding hundreds of messages in that very pile. The rows come from the mirror
   * (`shell/screener-state.ts` reads `engine.read()`), and before the mirror has been read there
   * are no senders to have an opinion about. Every sentence below asserts one.
   *
   * So the three settled states are held back until {@link MailState.settled}, and what is shown
   * instead names the situation and nothing else — no invented sender, no placeholder row. See
   * `OhboxView`'s `SyncState`, which this mirrors deliberately: one defect, one shape of answer.
   */
  if (!settled) {
    return (
      <div className="empty" role="status" aria-busy="true">
        {/* `.mbx-wait` and not a bare span: `.mbx-spin` sizes itself with `width`/`height` and
            is a `<span>`, so it needs a flex parent or the border collapses to a dot. That
            pairing — spinner beside one muted line — is exactly what `.mbx-wait` already is
            (`app.css`, beside the Settings rows), and reusing it adds no CSS and inherits the
            `prefers-reduced-motion` answer the ring already has. Same reuse `SyncBar` makes,
            for the same reason and with the same note about the `mbx-` prefix. */}
        <span className="mbx-wait">
          <span className="mbx-spin" aria-hidden="true" />
          {speak ? <b>{t("loading")}</b> : null}
        </span>
      </div>
    );
  }
  const key = segment === "screened" ? "screened" : segment;
  return (
    <div className="empty">
      <span className="glyph">{t(`empty.${key}.glyph`)}</span>
      <b>{t(`empty.${key}.title`)}</b>
      {t(`empty.${key}.hint`)}
    </div>
  );
}

export function ScreenerView({
  state,
  suggest,
  suggestNode,
  aiCreditNode,
  segment,
  selection,
  settled,
  onSelect,
  hydrateBody,
  remoteImages,
  onUnsubscribe,
  full,
  onFull,
}: {
  state: ScreenerState;
  /**
   * The purchase control, already bound to the senders it would cover. ABSENT on a surface
   * with no server behind it — the demo, and any test that does not care — and absent means
   * the control is not offered at all rather than offered and inert.
   */
  suggest?: SuggestBatchControl;
  /**
   * A CONTROL THE HOST BROUGHT, in place of the one above.
   *
   * Same seam as the injected Settings panes, and it exists for the same reason: this file is
   * compiled into a browser tab and into the desktop app, and the two are not asking the same
   * question. A hosted account buys suggestions out of an allowance, so the control above names a
   * price before it spends. A standalone install has no account and no allowance — the model is
   * one its owner set up — so the price is not merely a different number, it is a thing that does
   * not exist. Wording that around a shared control would put desktop vocabulary in this file and
   * account vocabulary in that binary, both wrong.
   *
   * When present it REPLACES {@link suggest}: never both, because two controls over one queue is
   * two ways to ask the same question with different words on them.
   */
  suggestNode?: ReactNode;
  /**
   * WHAT THE ACCOUNT'S AI ALLOWANCE IS DOING — one line under whichever control is offered above.
   *
   * Injected for the same reason both controls are: the answer is a billing read, and this file
   * is compiled into a binary that has no account. It is deliberately SEPARATE from
   * {@link suggest} rather than a field on it — the control describes a PURCHASE (these senders,
   * this price, this button) and this describes the account's standing (what is left, or why
   * nothing can be spent and what would change that). Folding the second into the first would
   * mean the sentence could only be shown while a ladder was open, which is precisely the moment
   * a person has already decided to spend.
   *
   * Rendered whether or not there is anything to buy, and that is the point of putting it beside
   * the resting state too: an exhausted allowance is most worth saying on the visit where the
   * suggest control has nothing to offer and no explanation for it.
   */
  aiCreditNode?: ReactNode;
  /**
   * The remote-image consent chrome, threaded to every held preview so the Screener's
   * "Show images" path is the reading pane's, unchanged. ABSENT on a client with no server
   * (the demo, a test) — `MessageBody` then blocks remote content and offers no button, which
   * is the correct posture, not a degraded one.
   */
  remoteImages?: RemoteImagesChrome;
  segment: ScreenerSegmentId;
  selection: Record<ScreenerSegmentId, string | null>;
  /**
   * May this view state its emptiness as a fact yet? Derived once in `shell/mail-state.ts`; a
   * prop for the reason it is one on `OhboxView`. See {@link Empty}.
   */
  settled: boolean;
  onSelect: (segment: ScreenerSegmentId, id: string | null) => void;
  /** Ask for one held message's body. `retry` marks a human asking again. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /**
   * Unsubscribe one held message's sender, server-side. ABSENT on a client with no server (the
   * demo, a test) — the screened-out / spam previews then offer no unsubscribe control rather
   * than a dead one. A refusal rejects with the server's own sentence.
   */
  onUnsubscribe?: (id: string) => Promise<UnsubscribeResult | null>;
  full: boolean;
  onFull: (full: boolean) => void;
}) {
  const t = useTranslations("screener");
  const [scopes, setScopes] = useState<Map<string, DecisionScope>>(() => new Map());
  const [choosing, setChoosing] = useState<"allow" | "notspam" | null>(null);
  /**
   * The chip in force, and the row whose destination menu is open. Both are PURE VIEW STATE:
   * nothing below writes to the mirror, dispatches a mutation or reaches the server, and a
   * reload forgets both. A filter that survived a reload would be a stored claim about which
   * senders exist.
   *
   * The open menu is held HERE and not per row so that opening one closes the last: seventy
   * rows each holding their own flag is seventy menus that can be open at once, over a list
   * whose rows slide away underneath them.
   */
  const [filter, setFilter] = useState<ScreenerFilterId | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  /**
   * THE SIX COUNTS, over the rows the apply button is counted over.
   *
   * `state.waiting` includes rows mid-exit — they are still on screen, sliding away — and
   * `suggestedCount` is derived from waiting MINUS everything already decided. Counting the
   * exiting ones here would put a chip one ahead of the button for the length of an animation,
   * and the two numbers are meant to be checkable against each other. One pass, six buckets.
   */
  const filterCounts = { ohbox: 0, reads: 0, receipts: 0, screened: 0, spam: 0, none: 0 } as Record<
    ScreenerFilterId,
    number
  >;
  for (const w of state.waiting) if (!state.isExiting(w.id)) filterCounts[filterGroupOf(w)]++;

  /**
   * A CHIP WHOSE GROUP HAS EMPTIED RELEASES ITSELF.
   *
   * Working a filtered queue ends with the last sender in it being decided, and the honest
   * answer to that is the whole queue again — not an empty pane under a pressed chip, which
   * states "there is nothing waiting" while the other five groups are full. Derived rather than
   * cleared in an effect: an effect would render the dead state once before fixing it.
   */
  const activeFilter = filter !== null && filterCounts[filter] > 0 ? filter : null;

  const items: Array<ScreenerSenderDTO | SpamRow> =
    segment === "waiting"
      ? activeFilter === null
        ? state.waiting
        : // Exiting rows are filtered by the same predicate as any other: their suggestion has
          // not changed, so a row decided from inside a group stays in that group and animates
          // away where the reader pressed it.
          state.waiting.filter((w) => filterGroupOf(w) === activeFilter)
      : segment === "screened"
        ? state.screenedOut
        : state.spam;

  const idOf = (x: ScreenerSenderDTO | SpamRow) =>
    "pinned" in x ? x.sender.id : x.id;
  const ids = items.map(idOf);
  const activeId = (() => {
    const sel = selection[segment];
    // Exiting rows stay visible but are no longer selectable targets.
    const selectable =
      segment === "waiting" ? ids.filter((id) => !state.isExiting(id)) : ids;
    if (sel && selectable.includes(sel)) return sel;
    return selectable[0] ?? null;
  })();

  const current = items.find((x) => idOf(x) === activeId) ?? null;
  const scopeOf = (s: ScreenerSenderDTO): DecisionScope =>
    scopes.get(s.id) ?? s.scope ?? "sender";

  /** The selected sender's held mail, whichever segment shape the row is. */
  const heldOfCurrent = current === null
    ? []
    : "pinned" in current ? current.sender.held : current.held;
  /**
   * The BODY STATES of the selected sender's held mail, as one string.
   *
   * The anchor below depends on it because a body landing changes the HEIGHT of an entry, and the
   * anchor is a pixel. It is the states and not the ids (`heldKey`, further down, is the ids and
   * drives the hydration): the ids are stable for the whole time the sender is selected, which is
   * precisely why keying the anchor on them left it computed against collapsed snippets for ever.
   */
  const heldBodyKey = heldOfCurrent.map((held) => held.bodyState ?? "").join(",");

  useEffect(() => {
    setChoosing(null);
  }, [activeId, segment]);

  /**
   * OPEN THE PREVIEW AT THE LATEST HELD MESSAGE — and STAY there while the bodies arrive.
   *
   * The held mail renders oldest→newest (`selectors.ts`: `held: [...newestFirst].reverse()`), so a
   * fresh render sits at the top on the OLDEST one and the consent decision is taken on the least
   * current thing the sender sent. The fix is the same one `MessagePane` applies to a conversation:
   * anchor the LAST `.hmail` by direct `scrollTop` (instant — `.scn-read`, `.read-col` in
   * `message.css`, declares no smooth scroll).
   *
   * ── WHY THE DEPENDENCY LIST GREW, AND IT IS A MEASURED BUG AND NOT A TIDY-UP ──────────────
   *
   * This used to be keyed on `[activeId, segment]` alone, with the comment *"so a body hydrating in
   * does not re-anchor a scrolled reader"*. That trade is the wrong way round, because the anchor is
   * a PIXEL and not an element reference:
   *
   *  · where a held row carries its body INLINE, `bodyOf` answers `full` on the first render
   *    (`m.body !== undefined`), so every `.hmail` is already at its final height when this runs
   *    and the anchor lands correctly. That is the demo world's shape;
   *  · where it does not, the row is DERIVED: `bodyOf` finds no `message_body` record, answers
   *    `snippet`, and the text arrives later through `hydrateBody`. The entries GROW after the pixel
   *    was computed. Three snippets at ~100px anchor at 186px; the same three hydrated are ~600px
   *    each, so 186px is inside the FIRST message.
   *
   * The second shape is every mailbox whose bodies are fetched on demand rather than shipped with
   * the row — which is the ordinary one, and the reason this looked correct while being wrong
   * wherever it mattered. Both shapes are exercised in `screener-latest-anchor.test.tsx`, which
   * models the growth explicitly because jsdom reports no layout and any assertion about this
   * arithmetic is otherwise green by construction.
   *
   * ── AND THE ORIGINAL CONCERN IS STILL HONOURED, WITHOUT A SCROLL LISTENER ─────────────────
   *
   * A reader who scrolls deliberately must not be dragged back. That is answered by remembering the
   * position we last WROTE ({@link ANCHOR_TOLERANCE_PX}): if the scroller has moved away from it,
   * the reader owns the column and this effect returns. No listener is needed to know that, and
   * there is no window in which our own write is mistaken for theirs. The OBSERVED value is stored
   * rather than the computed target, because a browser clamps `scrollTop` to the scrollable range
   * and a target beyond it would never match on the next pass.
   *
   * `anchoredFor` distinguishes a FRESH selection (always anchor, and forget the remembered
   * position) from a re-run caused by a body landing.
   */
  const anchorKey = `${segment}::${activeId ?? ""}`;
  const anchoredFor = useRef<string | null>(null);
  const anchoredAt = useRef<number | null>(null);
  useEffect(() => {
    const fresh = anchoredFor.current !== anchorKey;
    if (fresh) {
      anchoredFor.current = anchorKey;
      anchoredAt.current = null;
    }
    const read = document.querySelector<HTMLElement>(".view-screener .scn-read");
    if (!read) return;
    if (
      !fresh
      && anchoredAt.current !== null
      && Math.abs(read.scrollTop - anchoredAt.current) > ANCHOR_TOLERANCE_PX
    ) {
      return;
    }
    const entries = read.querySelectorAll<HTMLElement>(".hmail");
    const last = entries[entries.length - 1];
    if (!last) {
      read.scrollTo({ top: 0 });
      anchoredAt.current = null;
      return;
    }
    // The arithmetic is {@link heldAnchorTop} — extracted so a guard can drive it directly, because
    // jsdom reports every rect as zero and a mounted assertion cannot tell this formula from a
    // wrong one.
    read.scrollTop = heldAnchorTop(
      read.getBoundingClientRect().top, last.getBoundingClientRect().top, read.scrollTop,
    );
    // The OBSERVED value, not the target: a browser clamps `scrollTop` to the scrollable range, and
    // a stored target beyond it would never match on the next pass — which reads as "the reader
    // scrolled" and stops the re-anchoring this effect exists to do.
    anchoredAt.current = read.scrollTop;
  }, [anchorKey, heldBodyKey]);

  /* `scn-full-open` used to be set on <body> here, and the one rule that read it hid the
     floating ⌘K capsule while the mobile full-screen preview was up. The capsule is a group at
     the foot of the rail now — on a phone it rides the navigation drawer, which the preview
     already covers — so there is nothing to hide and nothing left reading the class. Removed
     rather than left set: a body class no stylesheet matches is a state the app claims to have
     and does not. */

  /**
   * THE SELECTED SENDER'S HELD MAIL, IN FULL.
   *
   * `ScreenerSenderDTO.held` has claimed "every held message, in full" since it was written,
   * and on a live account the claim was false: every row is derived, so every body was the
   * snippet and the consent decision was being taken on one line of text. Hydrating the
   * selected sender's held list is what makes the claim true — and it reduces the chance of
   * deciding WRONGLY, which is the only reason this pile gets its bodies by default while
   * Reads and Receipts stay collapsed.
   *
   * ── BOUNDED BY `held.length`, AND BY THE SELECTION ─────────────────────────────────────
   *
   * One sender at a time, never the queue. A waiting Screener holds one sender per stranger
   * and typically one to three messages each; the whole segment could be hundreds. The
   * `.join` in the dep list keys on the exact ids, so the effect re-runs when the selection
   * moves and not when a body lands — the record write bumps the mirror version, and a
   * dependency on that would re-enter this loop once per arriving body.
   *
   * ── AND IT IS THE ONLY THING SELECTION DOES ────────────────────────────────────────────
   *
   * Reading held mail stays SIDE-EFFECT-FREE: no `mark_seen`, no dwell timer, no waterline.
   * `hydrateBody` is a GET and writes nothing but a client-local record. The ⇧-twins in the
   * decision keys exist precisely because plain filing does not mark held mail read, and a
   * preview that marked it read on sight would make that distinction meaningless.
   */
  // `heldOfCurrent` is resolved once, up beside the anchor, so the two effects that read this
  // sender's held mail cannot disagree about which rows they mean.
  const heldKey = heldOfCurrent.map((h) => h.id).join(",");
  useEffect(() => {
    for (const id of heldKey ? heldKey.split(",") : []) hydrateBody(id);
  }, [heldKey, hydrateBody]);
  /** A human asking again — the only path allowed to re-ask a server that refused. */
  const retryBody = (id: string) => hydrateBody(id, { retry: true });

  /**
   * THE ROW MENU CLOSES ON THE NEXT THING THAT HAPPENS.
   *
   * It is a popover anchored to a row in a list whose rows slide away on a timer, so "press the
   * chevron again" is not a dismissal anyone can rely on — the row it hangs off may be gone by
   * then. Escape closes it, a press anywhere outside it closes it, and it is dropped outright
   * whenever the list underneath changes shape.
   */
  useEffect(() => {
    setMenuFor(null);
  }, [segment, activeFilter]);
  useEffect(() => {
    if (menuFor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    const onPointer = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.(".row-actions")) return;
      setMenuFor(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [menuFor]);

  const decideCurrent = (dest: Parameters<ScreenerState["decide"]>[1], read: boolean) => {
    if (!current || "pinned" in current) return;
    const next = ids.filter((id) => id !== current.id && !state.isExiting(id));
    state.decide(current, dest, { read, scope: scopeOf(current) });
    onSelect("waiting", next[0] ?? null);
  };

  /**
   * The Screener's keys, DECLARED.
   *
   * y/o/r/c/n/x used to live inside `DecisionBar`'s own `document` listener, which meant
   * the shell could not know that `c` is Receipts here and Compose everywhere else — it
   * carried a `screenerOwnsC` special case that reached into this view's state to guess.
   * The bar keeps its `keyboard` prop for other consumers; this view no longer passes it,
   * and the same six keys are a view layer that wins by the registry's own precedence
   * rule. They are also, for the first time, in the `?` sheet.
   */
  const waiting = segment === "waiting";
  const selectable = waiting ? ids.filter((id) => !state.isExiting(id)) : ids;
  const at = activeId ? Math.max(0, selectable.indexOf(activeId)) : 0;
  const step = (next: number) => {
    const id = selectable[next];
    if (!id) return;
    onSelect(segment, id);
    document
      .querySelector(`.view-screener .row[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  const decidable = waiting && current != null && !("pinned" in current);
  /**
   * Enter means "accept THE SUGGESTION", so it exists only when there is one.
   *
   * It read `current.ai?.dest ?? "ohbox"`, which on a live account made Enter a silent
   * "file to Ohbox" wearing the label "accept the suggested destination". The five
   * destination keys (o/r/c/n/x) are unaffected — those name what they do.
   */
  const suggested = (() => {
    const ai = decidable ? (current as ScreenerSenderDTO).ai : null;
    // `screener` names no filing — it is the server's `hold`, the model declining to place this
    // sender. Enter means "accept THE SUGGESTION", and there is none to accept, so the binding is
    // absent exactly as it is on a row nobody bought advice for. Returning it here would put the
    // string "screener" through `decideCurrent` as one of the five destinations, which it is not.
    return ai && ai.dest !== "screener" ? ai : null;
  })();

  const keys: KeyBinding[] = [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: at >= selectable.length - 1,
      run: () => step(at + 1),
    },
    {
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: at <= 0,
      run: () => step(at - 1),
    },
    {
      chord: "Escape",
      group: "screener",
      label: t("keyLeaveFull"),
      disabled: !full,
      run: () => onFull(false),
    },
    {
      chord: "Enter",
      group: "screener",
      label: t("keyAccept"),
      disabled: !suggested,
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      run: (e) => suggested && decideCurrent(suggested.dest as never, e.shiftKey),
    },
    {
      chord: "a",
      group: "screener",
      label: t("keyApplyAll"),
      // Same gate as the button, so the `?` sheet stops listing a key that would decide
      // every waiting sender by falling back to a destination nobody suggested.
      disabled: !waiting || state.suggestedCount === 0,
      run: () => state.applyAll(scopeOf),
    },
    {
      chord: "s",
      group: "screener",
      label: t("keyAllSpam"),
      disabled: !waiting || state.waitingCount === 0,
      run: () => state.markAllSpam(scopeOf),
    },
    // The five destinations, each with the letter that files it. The mail destinations also
    // carry a ⇧ twin that marks the held mail read; the demoting ones (Screen out, Spam) do
    // NOT — you don't read what you triage out, so the twin is dropped rather than made a
    // silent no-op, which would print the same destination twice in the `?` sheet. The
    // decision funnel in `screener-state.ts` clamps read for these regardless. SCR-READBOX.
    ...(["ohbox", "reads", "receipts", "screened", "spam"] as DecisionDestination[]).flatMap(
      (dest): KeyBinding[] => {
        const file: KeyBinding = {
          chord: DECISION_KEY[dest],
          group: "screener",
          label: t("keyFile", { dest: DECISION_DONE_LABEL[dest] }),
          disabled: !decidable,
          run: () => decideCurrent(dest as never, false),
        };
        if (DECISION_QUIET.has(dest)) return [file];
        return [
          file,
          {
            chord: `shift+${DECISION_KEY[dest]}`,
            group: "screener",
            label: t("keyFileRead", { dest: DECISION_DONE_LABEL[dest] }),
            disabled: !decidable,
            run: () => decideCurrent(dest as never, true),
          },
        ];
      },
    ),
  ];
  useKeyBindings(keys);

  const selectRow = (id: string) => {
    onSelect(segment, id);
    if (window.matchMedia("(max-width: 900px)").matches) onFull(true);
  };

  const row = (x: ScreenerSenderDTO | SpamRow) => {
    if (segment === "waiting") {
      const w = x as ScreenerSenderDTO;
      // Both fields come from the SAME message — the newest one, which is what
      // `w.time` already is. Pairing `w.time` with `held[0].subject` described a
      // message that does not exist (Lena's 08:40 stamp over her 08:12 subject).
      // Screened and spam rows already summarise the newest held message.
      const newest = newestHeld(w);
      return (
        <MessageRow
          key={w.id}
          id={w.id}
          from={displayAddressee(w.from.name, w.from.address)}
          address={displayAddressUnder(w.from.name, w.from.address)}
          time={newest?.time ?? w.time}
          subject={newest?.subject ?? ""}
          avatarInitial={w.initial}
          avatarHue={avatarHue(w.from.address)}
          dull={w.dull}
          selected={w.id === activeId}
          className={state.isExiting(w.id) ? "out" : undefined}
          /* THE ROW SAYS ITS LAST DECISION DID NOT LAND. `stateNote` is the badge strip's quiet
             "where does this stand" slot, which is exactly the question here — and unlike the
             toast it is still on screen a minute later. Before this, a refused decision put the
             sender back in the queue looking untouched; see `ScreenerState.refused`. */
          stateNote={state.refused(w.id) ? t("rowNotSaved") : undefined}
          aiSuggestion={
            w.ai
              ? {
                  // `screener` is in no `DECISION_DONE_LABEL` — the five there are the five a
                  // decision can FILE to, and this is the one that files nothing. The
                  // `?? w.ai.dest` fallback would print the raw view key "screener" in the row.
                  //
                  // THREE STATES, THREE CHIPS. A row with an answer names its pile; a row the
                  // model declined says the decision is yours; a row that never reached a model
                  // says so. All three used to be two, and the third read as nothing at all —
                  // which is how mail we never send to AI came to look like mail we forgot.
                  destLabel: w.ai.noAnswer
                    ? t("aiNoAnswerChip")
                    : w.ai.dest === "screener"
                      ? t("aiHoldChip")
                      : DECISION_DONE_LABEL[w.ai.dest as keyof typeof DECISION_DONE_LABEL] ?? w.ai.dest,
                  confidence: w.ai.confidence,
                }
              : undefined
          }
          heldCount={w.held.length}
          /* QUICK-ADJUST, on the row. Every branch of it goes through `state.decide` — the same
             funnel the decision bar, the five keys and both bulks use — so a row press earns
             the undo window, the read clamp, the rule promotion and the past-the-gate branch
             without this file knowing that any of them exist. See {@link RowActions}. */
          actions={
            <RowActions
              exiting={state.isExiting(w.id)}
              accept={acceptDestOf(w)}
              open={menuFor === w.id}
              onOpen={(o) => setMenuFor(o ? w.id : null)}
              onFile={(dest) => {
                setMenuFor(null);
                /* `scopeOf(w)` and not a hard "sender": the preview's scope switch writes the
                   per-sender choice this reads, so a reader who set this sender to domain scope
                   and then filed from the row gets the rule the bar in front of them named. It
                   IS "sender" for every row nobody has touched, which is the common case. */
                state.decide(w, dest, { read: false, scope: scopeOf(w) });
              }}
            />
          }
          onClick={() => selectRow(w.id)}
        />
      );
    }
    if (segment === "screened") {
      const w = x as ScreenerSenderDTO;
      return (
        <MessageRow
          key={w.id}
          id={w.id}
          /* NAME AND ADDRESS, AS IN `waiting`. These two segments printed the
             ADDRESS ALONE, which in the demo world is invisible — every screened and spam
             fixture is an address with no display name — and on a live account throws away
             the half a human recognises. Both are needed and for different reasons: the
             name is the screening signal, the address is what keeps the judgement
             spoof-safe. `MessageRow` renders the second only when there is a first, so a
             genuinely nameless sender still shows exactly one line. */
          from={displayAddressee(w.from.name, w.from.address)}
          address={displayAddressUnder(w.from.name, w.from.address)}
          time={screenedDate(w, t("today"))}
          subject={newestHeld(w)?.subject ?? ""}
          avatarInitial={w.initial}
          avatarHue={avatarHue(w.from.address)}
          /* DIMMED, FOR THE SAME REASON THE SPAM ROW BELOW IS. This pile holds senders already
             screened OUT — decisions taken, kept viewable so they stay reversible. Without `dull`
             a row gets `MessageRow`'s full-strength default, which in this product is the
             language for mail nobody has dealt with yet, so the entire pile read as unread and
             never stopped: nothing about a screened-out row ever changes its weight. The waiting
             queue above is the one segment that should be loud; these two are answers. */
          dull
          selected={w.id === activeId}
          heldCount={w.held.length}
          /* "ALLOW" DID NOT LAND — the same note the waiting row carries, for the same reason.
             A refused release leaves the sender here, and until this the row said nothing about
             it while the toast claimed the mail had gone. See `ScreenerState.refused`. */
          stateNote={state.refused(w.id) ? t("rowNotSaved") : undefined}
          onClick={() => selectRow(w.id)}
        />
      );
    }
    const r = x as SpamRow;
    return (
      <MessageRow
        key={r.sender.id}
        id={r.sender.id}
        from={displayAddressee(r.sender.from.name, r.sender.from.address)}
        address={displayAddressUnder(r.sender.from.name, r.sender.from.address)}
        time={newestHeld(r.sender)?.time ?? r.sender.time}
        subject={newestHeld(r.sender)?.subject ?? ""}
        avatarInitial={r.sender.initial}
        avatarHue={avatarHue(r.sender.from.address)}
        dull
        selected={r.sender.id === activeId}
        heldCount={r.sender.held.length}
        detection={r.pinned ? t("markedByYou") : r.sender.detection?.label}
        /* A REFUSED "NOT SPAM" SAYS SO, beside the detection badge rather than instead of it: the
           two answer different questions ("why is this here" / "where does this stand"), and a
           pinned row's "You marked this" is still true when the release that would have undone it
           was declined. See `ScreenerState.refused`. */
        stateNote={state.refused(r.sender.id) ? t("rowNotSaved") : undefined}
        onClick={() => selectRow(r.sender.id)}
      />
    );
  };

  return (
    <section className={full ? "view split view-screener scn-full" : "view split view-screener"}>
      <ListPane
        title={t("title")}
        /* "all clear" is the `=0` arm of this meta, and it is the same claim `Empty` makes:
           nobody is waiting at the gate. Before the mirror has been read nobody is KNOWN to be
           waiting. Any non-zero count is a real observation whatever the drain is doing, so
           only the zero is withheld — and it returns the moment there is one to state. */
        meta={
          !settled && state.waitingCount === 0
            ? undefined
            : t("metaWaiting", { count: state.waitingCount })
        }
        header={
          <div className="scn-head">
            <SegmentedControl<ScreenerSegmentId>
              className="scn-seg"
              role="tablist"
              ariaLabel={t("segAria")}
              value={segment}
              onChange={(seg) => goScreener(seg)}
              options={[
                {
                  id: "waiting",
                  label: t("segWaiting"),
                  count: state.waitingCount > 0 ? state.waitingCount : "",
                },
                {
                  id: "screened",
                  label: t("segScreened"),
                  count: state.screenedOut.length > 0 ? state.screenedOut.length : "",
                },
                {
                  id: "spam",
                  label: t("segSpam"),
                  count: state.spam.length > 0 ? state.spam.length : "",
                },
              ]}
            />
            {/* THE STRIP APPEARS FOR THE BULK CONTROLS **OR** FOR THE ALLOWANCE LINE, and the
                two conditions are genuinely different — which is what this wrapper used to get
                wrong. `waitingCount > 0` is right for the buttons (a bulk control may not outlive
                the thing it acts on) and exactly backwards for the line under them: `aiCreditNode`
                exists to explain an exhausted allowance, and an empty queue is when that
                explanation is most worth having, not least. Resolving the last waiting sender took
                both the remaining balance and the plan offer off the screen, contradicting this
                prop's own contract. */}
            {segment === "waiting" && (state.waitingCount > 0 || aiCreditNode) ? (
              <div className="scn-bulk">
                {state.waitingCount > 0 ? (
                  <>
                  {/* A BULK CONTROL MAY NOT OUTLIVE THE THING IT ACTS ON.
                      Gated on `suggestedCount`, never on `waitingCount`: with no suggestions
                      this button used to file every waiting stranger into the Ohbox and
                      promote a rule for each, while its label said it was applying
                      suggestions the user was never shown. `markAllSpam` says exactly what it
                      does and needs no such gate. */}
                  {state.suggestedCount > 0 ? (
                    <Button kbdHint="a" onClick={() => state.applyAll(scopeOf)}>
                      {t("applyAll", {
                        count: state.suggestedCount,
                        piles: pileList(state.suggestedDests, t),
                      })}
                    </Button>
                  ) : null}
                  {/* Its own control and not a branch of the one above, because the two are
                      opposite acts: this one BUYS advice, that one ACTS on advice already
                      bought. They are both visible while some senders have a suggestion and
                      others do not, which is the ordinary state of a queue being worked. */}
                  {suggestNode ?? (suggest ? <SuggestControl control={suggest} /> : null)}
                  <Button variant="ghost" kbdHint="s" onClick={() => state.markAllSpam(scopeOf)}>
                    {t("markAllSpam")}
                  </Button>
                  </>
                ) : null}
                {/* THE ALLOWANCE, one line under the control that spends it — last in the strip
                    and full-width, so it reads as a footnote to the row rather than as a fourth
                    button in it. It renders itself away when there is nothing worth saying, so
                    the ordinary case (AI on, plenty of allowance) is an unchanged strip. */}
                {aiCreditNode}
              </div>
            ) : null}
            {/* HOW FAR THE BULK HAS GOT. `applyAll` and `markAllSpam` dispatch one row every
                240ms, so a forty-sender press is ten seconds of work whose only evidence was
                rows leaving one at a time — a stagger and a stall look identical from here, and
                the summary toast that states a number does not arrive until the last row. Read
                off `state.applying`, which is null unless a run is in flight, so a finished run
                leaves nothing behind. */}
            {segment === "waiting" && state.applying ? (
              <div className="scn-applying">
                <span className="scn-applying-lab num" role="status">
                  {t("applying", {
                    done: state.applying.done,
                    total: state.applying.total,
                  })}
                </span>
                <BulkProgress done={state.applying.done} total={state.applying.total} />
              </div>
            ) : null}
            {/* THE PARTITION, under the controls that act on it. Waiting only: the screened-out
                and spam segments are already one group each, and a chip row over them would
                offer to filter a list by the one thing every row in it has in common. */}
            {segment === "waiting" ? (
              <FilterChips counts={filterCounts} value={activeFilter} onChange={setFilter} />
            ) : null}
          </div>
        }
        /* THE LEGEND IS GONE ENTIRELY NOW. Its previous trim (recorded in
           `screener-cloud.test.ts`) had already deleted the filing keys — `o r c n x file`
           named capsules in the other pane, and `y accept suggestion` named a key bound
           nowhere — on the rule that a key is documented on the verb it fires. The j/k/↵
           remainder fell to the same rule's last step: clamped to one line, it clipped
           mid-word in the split layout, and it was still a hand-typed copy of bindings the
           `?` sheet derives from the registry. One affordance remains — the key that opens
           that sheet. The bindings themselves are unchanged (`keys` above). */
        hints={<ShortcutHint />}
      >
        <ListRows>
          {items.length ? items.map(row) : <Empty segment={segment} settled={settled} />}
        </ListRows>
      </ListPane>

      <div className="read-col scn-read">
        {!current ? (
          // SHOW THE EMPTY STATE ONCE. When the segment holds nothing, the list pane already
          // renders `<Empty>` at `ListRows` above — and on mobile the list is the only pane
          // visible until a sender is opened. A second `<Empty>` here put the same glyph, title
          // and hint on screen twice, side by side on desktop. The read column is a preview area,
          // so with nothing to preview it stands empty, exactly as it does before a sender is
          // selected. `items.length` (not `current`) is the test: a `waiting` segment can have
          // rows that are all mid-exit — none selectable, so `current` is null while the list is
          // NOT empty — and there the read column keeps its own "nothing selected" state.
          items.length === 0 ? null : <Empty segment={segment} settled={settled} />
        ) : segment === "waiting" ? (
          <WaitingPreview
            sender={current as ScreenerSenderDTO}
            scope={scopeOf(current as ScreenerSenderDTO)}
            onScopeChange={(scope) => {
              const id = (current as ScreenerSenderDTO).id;
              setScopes((m) => new Map(m).set(id, scope));
            }}
            onDecide={(dest, opts) => decideCurrent(dest, opts.markRead)}
            onRetryBody={retryBody}
            bodyStall={state.bodyStall}
            remoteImages={remoteImages}
            onBack={() => onFull(false)}
          />
        ) : segment === "screened" ? (
          <ScreenedPreview
            sender={current as ScreenerSenderDTO}
            choosing={choosing === "allow"}
            onChoose={() => setChoosing("allow")}
            onCancel={() => setChoosing(null)}
            onAllow={(dest) => {
              state.allowScreened(current as ScreenerSenderDTO, dest);
              setChoosing(null);
            }}
            onRetryBody={retryBody}
            bodyStall={state.bodyStall}
            remoteImages={remoteImages}
            onUnsubscribe={onUnsubscribe}
            onBack={() => onFull(false)}
          />
        ) : (
          <SpamPreview
            row={current as SpamRow}
            choosing={choosing === "notspam"}
            onChoose={() => setChoosing("notspam")}
            onCancel={() => setChoosing(null)}
            onToWaiting={() => {
              state.notSpamToWaiting(current as SpamRow);
              setChoosing(null);
            }}
            onToOhbox={() => {
              state.notSpamToOhbox(current as SpamRow);
              setChoosing(null);
            }}
            onDelete={() => state.deleteSpam(current as SpamRow)}
            onRetryBody={retryBody}
            bodyStall={state.bodyStall}
            remoteImages={remoteImages}
            onUnsubscribe={onUnsubscribe}
            onBack={() => onFull(false)}
          />
        )}
      </div>
    </section>
  );
}

function screenedDate(w: ScreenerSenderDTO, today: string): string {
  const d = w.screenedOn ?? w.time;
  return /^\d{4}-/.test(d) ? today : d;
}

/** Rows summarise the newest held message; previews render every one of them. */
function newestHeld(w: ScreenerSenderDTO) {
  return w.held[w.held.length - 1];
}

/**
 * The remote-image consent wiring for ONE held message, resolved exactly as `MessagePane`
 * resolves it: `remoteLoaded` is the OR of the stored flag and this session's consent (the
 * body record is not re-fetched on consent, so without the second term the button would write
 * a row and change nothing on screen); the proxy is curried by message id, which is the
 * authorisation, not decoration; and an ABSENT chrome — the demo, a test with no API — offers
 * no button rather than a dead one. One place, so the three previews cannot drift.
 */
function heldRemoteProps(
  remoteImages: RemoteImagesChrome | undefined,
  h: { id: string; loadedRemoteContent?: boolean },
): { remoteLoaded: boolean; imageProxy: ((url: string) => string) | null; onLoadRemote?: () => void } {
  return {
    remoteLoaded: (h.loadedRemoteContent ?? false) || (remoteImages?.consented(h.id) ?? false),
    imageProxy: remoteImages ? remoteImages.proxyFor(h.id) : null,
    onLoadRemote: remoteImages ? () => remoteImages.consent(h.id) : undefined,
  };
}

/**
 * THE UNSUBSCRIBE CONTROL FOR ONE HELD MESSAGE (C).
 *
 * Rendered only in the screened-out and spam previews — the two piles whose held mail sits in a
 * reject folder the server will act on — and only once the body has hydrated to `full`, because
 * the posture is derived from the sender's headers and "we have not asked yet" (`no_header` on a
 * snippet) must not read as "there is no way out".
 *
 *  · `one_click`     — one explicit press IS the consent (the remote-images precedent: a control
 *                      that names the act needs no second dialog). The POST is server-side and
 *                      SSRF-gated, the URL never leaves the server, and `unsubscribe_records`
 *                      makes it at-most-once, so a repeat press is safe. The returned result is
 *                      rendered verbatim; a refusal arrives as a throw carrying the server's own
 *                      sentence.
 *  · `not_one_click` — no one-click route, but the sender publishes an https page: a plain
 *                      outbound link the reader opens themselves, named as leaving to the sender.
 *  · `mailto_only`   — the one refusal we owe an explanation: a route exists and ohmail declines
 *                      it, because it never sends mail on the user's behalf. Indicator, no action.
 */
function HeldUnsubscribe({
  state,
  url,
  onUnsubscribe,
}: {
  state: UnsubscribeHeaderState;
  url: string | null;
  onUnsubscribe: () => Promise<UnsubscribeResult | null>;
}) {
  const t = useTranslations("screener");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (state === "no_header") return null;

  if (state === "mailto_only") {
    return (
      <p className="hm-unsub note" role="status">
        {t("unsubMailtoOnly")}
      </p>
    );
  }

  if (state === "not_one_click") {
    if (!url) return null;
    return (
      <p className="hm-unsub">
        <Chip icon="door">{t("unsubOffered")}</Chip>
        <a className="hm-unsub-link" href={url} target="_blank" rel="noreferrer">
          {t("unsubExternal")}
        </a>
      </p>
    );
  }

  // one_click
  const run = async () => {
    if (busy || result) return;
    setBusy(true);
    try {
      const res = await onUnsubscribe();
      setResult(
        res && res.refusal === "already_recorded"
          ? t("unsubAlready")
          : res && res.posted
            ? t("unsubSent")
            : t("unsubDone"),
      );
    } catch (err) {
      // The server's own sentence — never a re-derived one (the same discipline `remoteImages`
      // keeps). A refused unsubscribe is a real, actionable fact only the server can phrase.
      setResult(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <p className="hm-unsub">
      <Chip icon="door">{t("unsubOffered")}</Chip>
      {result ? (
        <span className="hm-unsub-result" role="status">
          {result}
        </span>
      ) : (
        <Button variant="ghost" disabled={busy} onClick={run}>
          {busy ? t("unsubSending") : t("unsubscribe")}
        </Button>
      )}
    </p>
  );
}

function HeldMail({
  messageId,
  from,
  address,
  subject,
  time,
  body,
  html,
  bodyState,
  bodyStall,
  remoteLoaded,
  imageProxy,
  onLoadRemote,
  onRetry,
  unsubscribe,
  unsubscribeUrl,
  onUnsubscribe,
  trackerNote,
  dull,
}: {
  /**
   * Which held message this is — carried for {@link useBodyStalled}'s key and nothing else.
   * Absent on a mount that cannot name one (a fixture, a bare test), where the subject stands in.
   */
  messageId?: string;
  from: string;
  address?: string;
  subject: string;
  time?: string;
  body: string;
  /**
   * The sanitized-in-a-frame html part, when the body has hydrated to `full`. Null on a
   * fixture row and on every non-`full` state, so this preview falls back to the text part —
   * exactly the reading pane's behaviour. See {@link MessageBody}.
   */
  html?: string | null;
  /** Absent ⇒ full, which is a fixture row. See `ScreenerHeldMail.bodyState`. */
  bodyState?: BodyState;
  /**
   * Whether this message's body is stalled for good, and why — `ScreenerState.bodyStall`.
   * Null/absent means a body may still arrive, which is the only case that may show a spinner.
   */
  bodyStall?: HeldBodyStall | null;
  /** Whether remote content has been consented to for THIS held message. */
  remoteLoaded?: boolean;
  /** How to reach a remote image after consent, or null for "no way to". */
  imageProxy?: ((url: string) => string) | null;
  /** The reader pressed "Show images". Absent ⇒ no button, matching the pane. */
  onLoadRemote?: () => void;
  /** Ask for this held message's body again. Rendered only in the `failed` state. */
  onRetry?: () => void;
  /** This message's unsubscribe posture, from its hydrated body. Absent ⇒ no control. */
  unsubscribe?: UnsubscribeHeaderState;
  /** The sender's https unsubscribe page, for `not_one_click` only. */
  unsubscribeUrl?: string | null;
  /** Unsubscribe THIS message, server-side. Absent (the demo, waiting preview) ⇒ no control. */
  onUnsubscribe?: () => Promise<UnsubscribeResult | null>;
  trackerNote?: string;
  dull?: boolean;
}) {
  const t = useTranslations("body");
  /**
   * A CONSENT DECISION MUST NOT BE TAKEN ON TEXT THAT SILENTLY ISN'T THE MAIL.
   *
   * Every other pile can afford to say nothing while a body is in flight — the reader has a
   * pill and can ask again. Here the reader is about to decide whether a stranger may write
   * to them, and the difference between "this is all they said" and "this is the first line
   * of what they said" is the whole basis of that decision. `snippet` is included for that
   * reason, where the stream cards leave it silent: in this preview there is no pill standing
   * in for the same fact.
   *
   * AND IT CARRIES A CONTROL, for the reason the reading pane's does: the selection effect
   * above is an AUTOMATIC trigger, and `hydrateBody` deliberately refuses to re-ask a server
   * that already refused unless a human says so — otherwise a failing endpoint under an open
   * view is a request loop billed per attempt, with nobody behind it. Reselecting the sender
   * therefore does NOT retry, so without this button a held message whose body 500'd could
   * only be recovered by reloading the tab. In the one pile where the text is the basis of a
   * consent decision, that is not an acceptable dead end.
   */
  /**
   * ── AND THE SPINNER MUST BE A CLAIM ABOUT A REAL REQUEST ────────────────────────────────
   *
   * This used to map everything that was not `full` or `failed` to `t("loading")`, on the
   * argument written above it: selecting a sender hydrates its whole held list, so a `snippet`
   * on screen is a body already on its way. That argument is sound for the common case and
   * FALSE for two, and in both of them `hydrateBody` returns having asked for nothing — so the
   * sentence promised a request nobody would ever make and there was no control to escape it.
   * A protected held message and one whose row has left the mirror both sat under "Loading the
   * full message…" for as long as the sender stayed selected.
   *
   * `bodyStall` is that fact, read from the same predicate `hydrateBody` decides on
   * ({@link HeldBodyStall}). The four states are now distinguished by what is true of each:
   *
   *   protected  → the block, and no text at all, because a sensitive message's body must
   *                never be rendered — exactly as `MessagePane` does
   *                it — a spinner over a message whose body must not exist is the wrong
   *                sentence twice over.
   *   failed     → the failure, WITH Retry, unchanged.
   *   loading    → the spinner, and only here: a request is genuinely in the air.
   *   snippet
   *     · stalled  → nothing. The snippet is all there will ever be, and the preview shows it
   *                  rather than narrating a wait that has no end.
   *     · in flight → the spinner, which is the original argument, kept for the case it holds.
   */
  /**
   * ── AND EVEN A SPINNER OVER A REAL REQUEST HAS TO END ───────────────────────────────────
   *
   * `bodyStall` bounds the two cases where `hydrateBody` asks for NOTHING — a protected message
   * and a row that has left the mirror. It says nothing about the third: a request that departs,
   * is accepted, and never comes back. The record stays `loading`, no further mirror bump is
   * coming to re-drive it, and this preview says the body is on its way for as long as the sender
   * stays selected, with no control to escape it — the exact shape the reader surfaces were bounded
   * for, in the one pile where the text is the basis of a consent decision.
   *
   * So the same bound, from the same hook: past {@link BODY_STALL_MS} — the engine's own fetch
   * deadline plus the queue, derived rather than chosen here — the claim is retired and the
   * failure sentence WITH its Retry is shown instead. A body that arrives first clears `waiting`
   * and the timer with it, and `messageId` keys it so a stalled message cannot hand its verdict to
   * the next one rendered in its place.
   *
   * The Retry is the same human re-ask the `failed` state offers, and it is what makes the new
   * sentence honest: `hydrateBody` refuses an automatic re-ask, so without the button this state
   * would be a dead end with better wording.
   */
  const protectedMail = bodyStall === "protected";
  const waiting =
    !protectedMail
    && bodyState !== undefined
    && bodyState !== "full"
    && bodyState !== "failed"
    && (bodyState === "loading" || bodyStall == null);
  const stalled = useBodyStalled(messageId ?? subject, waiting);
  const failed = bodyState === "failed" || (waiting && stalled);
  const note =
    protectedMail || bodyState === undefined || bodyState === "full"
      ? null
      : failed
        ? t("failed")
        : waiting
          ? t("loading")
          : null;
  return (
    <article className={dull ? "hmail dull" : "hmail"}>
      <div className="hm-line">
        <b>{from}</b>
        {address ? <span className="addr">{address}</span> : null}
        <span className="t num">{time ?? ""}</span>
      </div>
      <h3>{subject}</h3>
      {trackerNote ? (
        <div className="hm-chips">
          <span className="badge shield">
            <Icon name="shield" size={10} /> {trackerNote}
          </span>
        </div>
      ) : null}
      {/* THE SAME RENDERER THE READING PANE USES — sanitized html in a sandboxed frame that
          cannot phone home, remote images blocked until consent — so the surface where a
          stranger's mail is judged is a mail client and not a text dump. With no html (a
          fixture row, or a body not yet hydrated to `full`) `MessageBody` renders the text
          part, which is what this preview showed before. */}
      <div className="hm-body">
        {protectedMail ? (
          /* SENSITIVE MAIL RENDERS NO TEXT IN THIS PILE EITHER. The gate is where a stranger's
             first mail is
             read, and a verification code from a stranger is the ordinary case rather than an
             exotic one. `MessagePane` has always routed a protected message past its body
             renderer; this preview handed the same message's text to `MessageBody` and then
             said it was still loading. The block carries its own default label — the string
             `ohbox.protectedPreview` and `reply.quotedProtected` already show elsewhere — so
             the reader gets the product's one answer for protected mail, not a third one. */
          <ProtectedBlock />
        ) : (
          <MessageBody
            text={body}
            html={html}
            remoteLoaded={remoteLoaded}
            imageProxy={imageProxy}
            onLoadRemote={onLoadRemote}
          />
        )}
      </div>
      {note ? (
        <p className={failed ? "hm-state warn" : "hm-state"} role="status">
          {note}{" "}
          {failed && onRetry ? (
            <Button variant="ghost" onClick={onRetry}>
              {t("retry")}
            </Button>
          ) : null}
        </p>
      ) : null}
      {/* The unsubscribe control (C): only once the body is hydrated (`full`), so the posture is
          real, and only where a server can act on it (`onUnsubscribe` present — absent on the
          demo and in the waiting preview). */}
      {!protectedMail && bodyState === "full" && onUnsubscribe && unsubscribe ? (
        <HeldUnsubscribe state={unsubscribe} url={unsubscribeUrl ?? null} onUnsubscribe={onUnsubscribe} />
      ) : null}
    </article>
  );
}

function WaitingPreview({
  sender,
  scope,
  onScopeChange,
  onDecide,
  onRetryBody,
  bodyStall,
  remoteImages,
  onBack,
}: {
  sender: ScreenerSenderDTO;
  scope: DecisionScope;
  onScopeChange: (scope: DecisionScope) => void;
  onDecide: Parameters<typeof DecisionBar>[0]["onDecide"];
  /** Ask for one held message's body again. */
  onRetryBody: (id: string) => void;
  /** `ScreenerState.bodyStall`, per held id — see {@link HeldBodyStall}. */
  bodyStall: (messageId: string) => HeldBodyStall | null;
  remoteImages?: RemoteImagesChrome;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  // What the decision bar SAYS the rule will cover. Display only — the rule the decision writes
  // keys on the stored address (`screener-state.ts` → `decide`), which is why this may be decoded.
  const ruleTarget =
    scope === "domain" ? displayDomainLabel(sender.from.address) : displayAddress(sender.from.address);
  const aiDest = sender.ai?.dest as Parameters<typeof DecisionBar>[0]["aiDest"];
  return (
    <>
      <DecisionBar
        aiDest={aiDest}
        scope={scope}
        onScopeChange={onScopeChange}
        ruleTarget={ruleTarget}
        onDecide={onDecide}
        onBack={onBack}
      />
      <div className="scn-mails">
        {/**
          * THE ABSENCE OF A SUGGESTION IS ITSELF SOMETHING TO SAY.
          *
          * This block used to render only in the `ai` branch, so on a live account — where
          * `ai` is null for every derived row — the preview said nothing at all, and the
          * reader was left looking for a suggestion the surface had never admitted it did
          * not have. "Every mail says why" is published copy; silence does not satisfy it.
          *
          * The FACT is shared with `AiSection`'s `status` line ("no live model is connected
          * yet") and both change together the day a classifier is wired into the server's
          * dependencies — the same trigger `AiSection.tsx` already names.
          *
          * THE WORDING IS NO LONGER SHARED, and that is a deliberate correction. This
          * used to end *"Pick a door."*, borrowed from the marketing page's AI-off row.
          * There the metaphor is established one screen earlier — `hero.door` is the
          * landing's own paragraph — and here nothing has ever been called a door: the
          * capsules beside this sentence say Ohbox, Reads, Receipts, Screen out, Spam. A
          * word the surface never defines is not shorthand, it is a second vocabulary. The
          * marketing line keeps its own.
          */}
        {sender.ai ? (
          <div className="scn-why">
            <Icon name="spark" />
            {/* A `hold` gets its own SENTENCE and not a third capsule in the first one.
                "AI suggests <b>X</b>" is a claim that X is where this mail goes, and the whole
                defect being fixed here was that sentence naming a destination the model had
                explicitly declined to choose. There is no wording of "suggests" that is true
                of a non-answer, so the verb changes. The confidence and the rationale stay —
                the account paid for them, and the model IS 0.92 sure this is a stranger for a
                person to place. */}
            {/* A sender the run could not answer for says WHY, and says it here rather than
                leaving the row blank. There is no confidence and no rationale to print — nothing
                was asked — so this branch is one sentence and stops. */}
            {sender.ai.noAnswer ? (
              <span>{t(`aiSkip.${sender.ai.noAnswer}`)}</span>
            ) : sender.ai.dest === "screener" ? (
              <span>
                {t("aiHolds")}{" "}
                <span className="conf num">{sender.ai.confidence.toFixed(2)}</span> —{" "}
                <span className="why">{t("aiWhy", { why: sender.ai.rationale })}</span>
              </span>
            ) : (
              <span>
                {t("aiSuggests")}{" "}
                <b>
                  {DECISION_DONE_LABEL[sender.ai.dest as keyof typeof DECISION_DONE_LABEL] ??
                    sender.ai.dest}
                </b>{" "}
                <span className="conf num">{sender.ai.confidence.toFixed(2)}</span> —{" "}
                <span className="why">{t("aiWhy", { why: sender.ai.rationale })}</span>
              </span>
            )}
          </div>
        ) : (
          <div className="scn-why scn-why-none">
            <span>{t("noSuggestion")}</span>
          </div>
        )}
        {sender.held.length > 1 ? (
          <div className="scn-caption num">
            {t("heldCaption", {
              count: sender.held.length,
              time: sender.held[0]?.time ?? "",
            })}
          </div>
        ) : null}
        {sender.held.map((h) => (
          <HeldMail
            key={h.id}
            messageId={h.id}
            from={displayAddressee(sender.from.name, sender.from.address)}
            address={displayAddressUnder(sender.from.name, sender.from.address)}
            subject={h.subject}
            time={h.time}
            body={h.body}
            html={h.html}
            bodyState={h.bodyState}
            onRetry={() => onRetryBody(h.id)}
            bodyStall={bodyStall(h.id)}
            trackerNote={h.trackerNote}
            dull={sender.dull}
            {...heldRemoteProps(remoteImages, h)}
          />
        ))}
      </div>
    </>
  );
}

function ScreenedPreview({
  sender,
  choosing,
  onChoose,
  onCancel,
  onAllow,
  onRetryBody,
  bodyStall,
  remoteImages,
  onUnsubscribe,
  onBack,
}: {
  sender: ScreenerSenderDTO;
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onAllow: (dest: "ohbox" | "reads") => void;
  onRetryBody: (id: string) => void;
  /** `ScreenerState.bodyStall`, per held id — see {@link HeldBodyStall}. */
  bodyStall: (messageId: string) => HeldBodyStall | null;
  remoteImages?: RemoteImagesChrome;
  onUnsubscribe?: (id: string) => Promise<UnsubscribeResult | null>;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  return (
    <>
      <div className="decide">
        <button type="button" className="scn-back" onClick={onBack}>
          <Icon name="chev" className="chev" /> {t("back")}
        </button>
        <div className="d-btns">
          {choosing ? (
            <>
              <span className="choose-lab">{t("allowLabel")}</span>
              <Button onClick={() => onAllow("ohbox")}>{t("allowOhbox")}</Button>
              <Button onClick={() => onAllow("reads")}>{t("allowReads")}</Button>
              <Button variant="ghost" onClick={onCancel}>
                {t("cancel")}
              </Button>
            </>
          ) : (
            <Button onClick={onChoose}>{t("allow")}</Button>
          )}
        </div>
        <div className="d-sub">
          <span className="d-note num">
            {t("screenedNote", {
              date: screenedDate(sender, t("today")),
              count: sender.held.length,
            })}
          </span>
        </div>
      </div>
      {/* NO-COLLAPSE: every held message renders, oldest first. */}
      <div className="scn-mails">
        <div className="scn-caption num">
          {t("heldCaptionAll", { count: sender.held.length })}
        </div>
        {/* Name AND address, matching the waiting preview — see the screened row. */}
        {sender.held.map((h) => (
          <HeldMail
            key={h.id}
            messageId={h.id}
            from={displayAddressee(sender.from.name, sender.from.address)}
            address={displayAddressUnder(sender.from.name, sender.from.address)}
            subject={h.subject}
            time={h.time}
            body={h.body}
            html={h.html}
            bodyState={h.bodyState}
            onRetry={() => onRetryBody(h.id)}
            bodyStall={bodyStall(h.id)}
            unsubscribe={h.unsubscribe}
            unsubscribeUrl={h.unsubscribeUrl}
            onUnsubscribe={onUnsubscribe ? () => onUnsubscribe(h.id) : undefined}
            trackerNote={h.trackerNote}
            dull
            {...heldRemoteProps(remoteImages, h)}
          />
        ))}
      </div>
    </>
  );
}

function SpamPreview({
  row,
  choosing,
  onChoose,
  onCancel,
  onToWaiting,
  onToOhbox,
  onDelete,
  onRetryBody,
  bodyStall,
  remoteImages,
  onUnsubscribe,
  onBack,
}: {
  row: SpamRow;
  choosing: boolean;
  onChoose: () => void;
  onCancel: () => void;
  onToWaiting: () => void;
  onToOhbox: () => void;
  onDelete: () => void;
  onRetryBody: (id: string) => void;
  /** `ScreenerState.bodyStall`, per held id — see {@link HeldBodyStall}. */
  bodyStall: (messageId: string) => HeldBodyStall | null;
  remoteImages?: RemoteImagesChrome;
  onUnsubscribe?: (id: string) => Promise<UnsubscribeResult | null>;
  onBack: () => void;
}) {
  const t = useTranslations("screener");
  const held = row.sender.held;
  const detection = row.pinned ? t("markedByYou") : row.sender.detection?.label;
  return (
    <>
      <div className="decide">
        <button type="button" className="scn-back" onClick={onBack}>
          <Icon name="chev" className="chev" /> {t("back")}
        </button>
        <div className="d-btns">
          {choosing ? (
            <>
              <span className="choose-lab">{t("notSpamLabel")}</span>
              {!row.pinned ? (
                <Button onClick={onToWaiting}>{t("notSpamScreener")}</Button>
              ) : null}
              <Button onClick={onToOhbox}>{t("notSpamOhbox")}</Button>
              <Button variant="ghost" onClick={onCancel}>
                {t("cancel")}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onChoose}>{t("notSpam")}</Button>
              {/* Delete is a DEMO affordance: it hides the row and nothing else. There
                  is no delete endpoint, so on a live account (every row derived) the
                  button would lie until the next reload brought the mail back. It is
                  not offered there. */}
              {row.sender.derived ? null : (
                <Button variant="ghost" onClick={onDelete}>
                  {t("delete")}
                </Button>
              )}
            </>
          )}
        </div>
        <div className="d-sub">
          <span className="d-note">{t("spamNote")}</span>
        </div>
      </div>
      {/* NO-COLLAPSE: spam is held viewable — all of it, not the newest of it. */}
      <div className="scn-mails">
        {detection ? <div className="scn-caption">{detection}</div> : null}
        {held.length > 1 ? (
          <div className="scn-caption num">{t("heldCaptionAll", { count: held.length })}</div>
        ) : null}
        {held.map((h) => (
          <HeldMail
            key={h.id}
            messageId={h.id}
            from={displayAddressee(row.sender.from.name, row.sender.from.address)}
            address={displayAddressUnder(row.sender.from.name, row.sender.from.address)}
            subject={h.subject}
            time={h.time}
            body={h.body}
            html={h.html}
            bodyState={h.bodyState}
            onRetry={() => onRetryBody(h.id)}
            bodyStall={bodyStall(h.id)}
            unsubscribe={h.unsubscribe}
            unsubscribeUrl={h.unsubscribeUrl}
            onUnsubscribe={onUnsubscribe ? () => onUnsubscribe(h.id) : undefined}
            trackerNote={h.trackerNote}
            dull
            {...heldRemoteProps(remoteImages, h)}
          />
        ))}
      </div>
    </>
  );
}
