"use client";

/**
 * THE SENT-MAIL SEED — "you've written to these people; shall I let them through?"
 *
 * The first question a new mailbox is asked cannot be "who do you want to hear from", because
 * nobody can answer that against fifteen thousand messages. The strongest thing anybody has
 * done towards a correspondent is WRITE TO THEM, and that is already sitting in the mailbox.
 *
 * ── THE LIST IS SHOWN BEFORE IT ACTS, AND THAT IS THE WHOLE SCREEN ────────────────────────
 *
 * Everything here exists so the confirmation is informed rather than assumed:
 *
 *   · the count is stated first, and it is the count of PEOPLE, not of messages;
 *   · every row is unticked-able, and the button says how many are ticked right now;
 *   · the robot filter's removals are DISCLOSED, collapsed, with the reason it gave — a
 *     filter nobody can inspect is a filter nobody can correct;
 *   · the sentence above the button says what pressing it will do, and what it will not do.
 *
 * The last one is the one worth being stubborn about. This writes rules and moves nothing:
 * confirming consent for four hundred people must never turn into four hundred moves inside
 * somebody's real mailbox, and somebody about to press a button that could is entitled to
 * know it will not before they press it rather than after.
 *
 * ── A FAILED CONFIRM KEEPS THE CURATION ───────────────────────────────────────────────────
 *
 * Someone who has just gone down a list of two hundred people unticking the twelve they would
 * rather screen has done real work, and it exists nowhere but in this component. The failure
 * path therefore keeps the review AND the tick state and renders the error above the list, so
 * "try again" is one press. It used to replace the whole screen with an apology and a way out,
 * which threw the curation away — and losing somebody's work is worse than the failure that
 * caused it, because the failure was usually transient and the work is not recoverable.
 *
 * ── AND THE CONFIRM MAY BE PRESSED MORE THAN ONCE ─────────────────────────────────────────
 *
 * The server writes a rule for whoever does not have one and skips whoever does, so a second
 * press adds nothing and a retry is safe. The idempotency key this screen mints per press is
 * still the thing that separates "the user pressed twice" from "the first response never
 * arrived": a retry of the same press replays its answer rather than re-running the question.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { ApiError, consent as consentApi, type SeedReviewWire } from "../api-client";
import { displayAddress } from "../shell/idn";

type Phase =
  | { state: "loading" }
  /** The list is up. `error` is set when a confirm came back refused — the ticks are kept. */
  | { state: "ready"; review: SeedReviewWire; error?: string }
  | { state: "confirming"; review: SeedReviewWire }
  /** Nothing to show. Only the LIST's own failure reaches this: there is no curation to keep. */
  | { state: "unavailable"; message: string };

/** A stable key per press, so a retry replays rather than re-asks. */
const newKey = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function SeedReviewView({
  onDone,
  onLater,
}: {
  /** The consent event landed. The caller re-reads the world; the mirror has not seen the rules yet. */
  onDone: () => void;
  /** Left without answering. Nothing was written, and the offer stands next time. */
  onLater: () => void;
}) {
  const t = useTranslations("seed");
  const [phase, setPhase] = useState<Phase>({ state: "loading" });
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const review = await consentApi.seedReview();
        if (!live) return;
        setPhase({ state: "ready", review });
        // EVERYONE STARTS TICKED. The list is people the user has written to — the default is
        // the answer that matches what they already did — and a screen that starts empty makes
        // somebody tick four hundred boxes to get where writing to those people already put
        // them. Anyone already decided about is left out: they are shown, not re-written.
        setChecked(new Set(review.candidates.filter((c) => !c.alreadyDecided).map((c) => c.address)));
      } catch (err) {
        if (!live) return;
        setPhase({
          state: "unavailable",
          message: err instanceof ApiError ? err.message : t("errorGeneric"),
        });
      }
    })();
    return () => { live = false; };
  }, [t]);

  const review = phase.state === "ready" || phase.state === "confirming" ? phase.review : null;

  const shown = useMemo(() => {
    if (!review) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return review.candidates;
    return review.candidates.filter(
      (c) => c.address.includes(q) || (c.name ?? "").toLowerCase().includes(q),
    );
  }, [review, filter]);

  /**
   * The rows a bulk action may touch: what the filter is showing, minus anyone already decided
   * about. Their boxes are disabled, and a "select all shown" that silently ticked a row the
   * user cannot untick would be lying about what the button did.
   */
  const actionable = useMemo(() => shown.filter((c) => !c.alreadyDecided), [shown]);
  const shownChecked = useMemo(
    () => actionable.filter((c) => checked.has(c.address)).length,
    [actionable, checked],
  );
  /**
   * Whether the bulk pair is offered at all — a question about the WHOLE list, not the filtered
   * one, so the controls do not appear and vanish under the cursor as somebody types. What they
   * ACT on is still only what is shown; that is the part that must never widen.
   */
  const bulkOffered = useMemo(
    () => (review?.candidates.filter((c) => !c.alreadyDecided).length ?? 0) > 1,
    [review],
  );

  const toggle = useCallback((address: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }, []);

  /**
   * TICK OR UNTICK EVERYTHING THE FILTER IS SHOWING — and only that.
   *
   * The list is the whole point of the screen and it is long; on a real mailbox it is hundreds
   * of rows. Search narrows it to "everyone at that old employer" or "everything from that
   * mailing list I answered once", and the answer the user has in mind for that subset is one
   * answer, not forty clicks. Scoped to the FILTERED rows rather than the whole list, because
   * a control that reaches past what is on screen is the one that loses somebody's curation.
   */
  const setShown = useCallback((on: boolean) => {
    setChecked((s) => {
      const next = new Set(s);
      for (const c of actionable) {
        if (on) next.add(c.address);
        else next.delete(c.address);
      }
      return next;
    });
  }, [actionable]);

  const confirm = useCallback(async () => {
    if (!review) return;
    setPhase({ state: "confirming", review });
    try {
      await consentApi.confirmSeed([...checked], { idempotencyKey: newKey() });
      onDone();
    } catch (err) {
      // THE REVIEW AND THE TICKS SURVIVE. `checked` is untouched — it lives outside `phase` for
      // exactly this reason — so the retry sends the same curated list the failed press did.
      setPhase({
        state: "ready",
        review,
        error: err instanceof ApiError ? err.message : t("errorGeneric"),
      });
    }
  }, [review, checked, onDone, t]);

  if (phase.state === "loading") {
    return (
      <section className="view center view-seed">
        <div className="gate-card" aria-busy="true">
          <p className="set-note-inline">{t("loading")}</p>
        </div>
      </section>
    );
  }

  if (phase.state === "unavailable") {
    return (
      <section className="view center view-seed">
        <div className="gate-card">
          <h1>{t("errorTitle")}</h1>
          {/* The SERVER's sentence, verbatim. A second copy of the taxonomy here is how
              somebody ends up being told the wrong reason. */}
          <p className="set-note-inline">{phase.message}</p>
          <Button variant="ghost" onClick={onLater}>{t("later")}</Button>
        </div>
      </section>
    );
  }

  const busy = phase.state === "confirming";
  const failure = phase.state === "ready" ? phase.error : undefined;

  return (
    <section className="view center view-seed">
      <div className="seed-card">
        <h1>{t("title", { count: review!.candidates.length })}</h1>
        <p className="view-note">{t("lede")}</p>
        {review!.truncated ? <p className="view-note">{t("truncated", { scanned: review!.scannedMessages })}</p> : null}

        {/* THE REFUSAL SITS ABOVE THE LIST, NOT INSTEAD OF IT. Everything the user has ticked
            and unticked is still on screen and still theirs; the only thing that failed is the
            press. `role="alert"` because it appears after the fact, in response to an action. */}
        {failure ? (
          <p className="seed-error" role="alert">
            <strong>{t("errorTitle")}</strong> {failure} {t("errorRetry")}
          </p>
        ) : null}

        <input
          className="seed-filter"
          type="search"
          value={filter}
          placeholder={t("filterPlaceholder")}
          aria-label={t("filterPlaceholder")}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />

        {/* BULK, AND SCOPED TO THE SEARCH. Both directions, because both are real: "everyone
            from that project, yes" and "this whole mailing list, no" are the same gesture. The
            counts name what will be touched, so neither button is a leap of faith. */}
        {bulkOffered ? (
          <div className="seed-bulk">
            <Button
              variant="ghost"
              disabled={busy || actionable.length === 0 || shownChecked === actionable.length}
              onClick={() => setShown(true)}
            >
              {t("selectShown", { count: actionable.length })}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || shownChecked === 0}
              onClick={() => setShown(false)}
            >
              {t("deselectShown", { count: shownChecked })}
            </Button>
          </div>
        ) : null}

        <ul className="seed-list">
          {shown.map((c) => (
            <li key={c.address} className="seed-row">
              <label>
                <input
                  type="checkbox"
                  checked={checked.has(c.address)}
                  disabled={c.alreadyDecided || busy}
                  onChange={() => toggle(c.address)}
                />
                {/* Labels only. The checkbox's key and the `checked` set above stay on the STORED
                    address, which is also what the decision this screen writes carries. */}
                <span className="seed-who">{c.name ?? displayAddress(c.address)}</span>
                {c.name ? <span className="seed-addr">{displayAddress(c.address)}</span> : null}
                <span className="seed-count">{t("wroteN", { count: c.messages })}</span>
                {/* Shown, and not silently dropped: a person already decided about is part of
                    why the number on the button is smaller than the list. */}
                {c.alreadyDecided ? <span className="seed-note">{t("alreadyDecided")}</span> : null}
              </label>
            </li>
          ))}
        </ul>

        {review!.excluded.length ? (
          <details
            className="seed-excluded"
            open={showExcluded}
            onToggle={(e) => setShowExcluded((e.currentTarget as HTMLDetailsElement).open)}
          >
            {/* COLLAPSED, NOT HIDDEN. The robot filter is the part of this screen nobody asked
                for and the part most likely to be wrong about somebody, so it says what it
                removed and why, one press away. */}
            <summary>{t("excludedSummary", { count: review!.excluded.length })}</summary>
            <ul className="seed-list">
              {review!.excluded.map((e) => (
                <li key={e.address} className="seed-row">
                  <span className="seed-who">{displayAddress(e.address)}</span>
                  <span className="seed-note">{t(`excluded.${e.reason}`)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {/* WHAT THE BUTTON WILL DO, BEFORE IT IS PRESSED — including the thing it will not do. */}
        <p className="view-note">{t("willDo", { count: checked.size })}</p>
        <div className="gate-actions">
          <Button onClick={confirm} disabled={busy}>
            {busy ? t("confirming") : t("confirm", { count: checked.size })}
          </Button>
          <Button variant="ghost" onClick={onLater} disabled={busy}>{t("later")}</Button>
        </div>
      </div>
    </section>
  );
}
