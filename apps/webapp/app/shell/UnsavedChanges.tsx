"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import type { AbandonedMutation, MutationResult } from "@ohmail/client-engine";

/** What a retry answers — the engine's own result, carried to the row that asked for it. */
type RetryOutcome = MutationResult;
import { useEngine, useAbandoned } from "./engine";
import "./unsaved-changes.css";

/**
 * The changes that did not land — a strip that appears only when there are some, and the two answers a person
 * actually has. Separate from `SyncBar` because that returns null when sync is healthy — and an abandoned change is
 * most likely precisely then: syncing is fine, one verb the server kept refusing is not. It exists because the engine
 * used to retry a refused change for ever; bounding that (`OUTBOX_MAX_SERVER_FAILURES`) opens a worse question — what
 * happens to the work, and a queue that silently drops what it gave up on is data loss wearing a bug fix's clothes.
 * "Try again" re-queues under the ORIGINAL Idempotency-Key, so an attempt that committed and lost its response
 * replays rather than doing the thing twice; "Discard" throws it away. Deliberately no "retry all": the reasons
 * differ, and a button re-queuing eight verbs on one press has an outcome nobody can predict. One row, one decision.
 */
export function UnsavedChanges({ variant }: { variant: "shell" | "rail" }) {
  const engine = useEngine();
  const abandoned = useAbandoned();
  return (
    <UnsavedChangesList
      variant={variant}
      abandoned={abandoned}
      // THE RESULT IS CONSUMED, not discarded. `.then(() => undefined)` was here, and it made a
      // retried send answering `send_unverified` invisible: no warning, no record (it is deleted
      // before dispatch), and a person free to press send again on mail that may already have left.
      onRetry={(id) => engine.retryAbandoned(id)}
      onDiscard={(id) => engine.discardAbandoned(id)}
    />
  );
}

/**
 * THE PURE HALF — props in, markup out, no engine and no hooks but its own.
 *
 * Split for the reason `MarkAllRead` is shaped the same way: a component that reaches into a
 * context can only be tested by standing up that context, and the thing under test here is what a
 * person SEES when a change did not land. A test that has to build an engine, a mirror and a
 * session to observe one sentence ends up asserting the scaffolding.
 */
export function UnsavedChangesList({
  abandoned,
  onRetry,
  onDiscard,
  variant = "shell",
}: {
  abandoned: readonly AbandonedMutation[];
  onRetry: (id: string) => Promise<RetryOutcome>;
  onDiscard: (id: string) => Promise<void>;
  /**
   * WHICH ARRANGEMENT this copy belongs to — the same two the sync line has, and for the same
   * reason. Both are mounted at once and CSS decides which is visible, so each needs a class the
   * one breakpoint in `app.css` can address. Without it both were on screen together above 901px:
   * one sentence twice, and two `role="status"` regions announcing it in turn.
   */
  variant?: "shell" | "rail";
}) {
  const t = useTranslations("sync");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** The last retry's own sentence, when it had one — see {@link retry}. */
  const [said, setSaid] = useState<{ id: string; code: string; message: string } | null>(null);

  const retry = useCallback(async (id: string) => {
    setBusy(id);
    try {
      const outcome = await onRetry(id);
      // For a verb `ownerSettled` covers, this row is the only thing waiting on the result, so a
      // terminal answer has to be said here or it is said nowhere. A confirmed or queued retry
      // simply removes the row (the list re-reads); anything else leaves a sentence.
      const code = outcome.error?.code ?? null;
      setSaid(code === null ? null : { id, code, message: outcome.error?.message ?? "" });
    } finally {
      setBusy(null);
    }
  }, [onRetry]);

  const discard = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await onDiscard(id);
    } finally {
      setBusy(null);
    }
  }, [onDiscard]);

  /**
   * Nothing to say, nothing on screen — except a result that has not been said yet. Absent-at-zero
   * is right (a strip reading "0 changes could not be saved" lies about the state it describes),
   * but it collided with the retry outcome: the retry's answer rendered inside the row it belonged
   * to, and a terminal retry REMOVES that row — so a last record retried into `send_unverified` hit
   * this return before it could say "check your Sent folder", and nothing stopped a second send of
   * mail that may already have left. A pending sentence keeps the strip alive on its own; it
   * outlives every row, because the outcome it carries is about work that no longer has one.
   */
  if (abandoned.length === 0 && said === null) return null;

  return (
    <div className={`unsaved unsaved-${variant}`} role="status" aria-live="polite">
      {abandoned.length === 0 && said !== null ? (
        <div className="unsaved-line">
          <span className="unsaved-glyph" aria-hidden="true">!</span>
          <span className="unsaved-why">{said.message || t("unsavedNoReason")}</span>
          <button type="button" className="unsaved-toggle" onClick={() => setSaid(null)}>
            {t("unsavedDismiss")}
          </button>
        </div>
      ) : null}
      {abandoned.length === 0 ? null : (
      <div className="unsaved-line">
        <span className="unsaved-glyph" aria-hidden="true">!</span>
        <b>{t("unsavedCount", { count: abandoned.length })}</b>
        <button
          type="button"
          className="unsaved-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("unsavedHide") : t("unsavedShow")}
        </button>
      </div>
      )}

      {open ? (
        <ul className="unsaved-list">
          {abandoned.map((m) => (
            <li key={m.id} className="unsaved-row">
              <div className="unsaved-what">
                <b>{describe(m, t)}</b>
                {/* THE SERVER'S OWN SENTENCE, never a category invented here — the code that made
                    the decision wrote a true one. Where it said nothing usable (an unhandled 500
                    says "internal error"), `describe` does not repeat it; see below. */}
                <span className="unsaved-why">
                  {said?.id === m.id
                    ? (said.message || t("unsavedNoReason"))
                    : m.superseded ? t("unsavedSuperseded") : reason(m, t)}
                </span>
              </div>
              <div className="unsaved-acts">
                {/* NO TRY AGAIN once a newer change to the same thing has been saved: replaying
                    this one would overwrite the newer intent with an older one the person cannot
                    see is stale. Discard stays, because the record is still theirs to clear. */}
                {/* A refusal is durable: the record carries WHY, so the control does not come
                    back on the next render offering a press that cannot do anything. */}
                {!m.retryable ? null : (
                  <button type="button" disabled={busy === m.id} onClick={() => void retry(m.id)}>
                    {t("unsavedRetry")}
                  </button>
                )}
                <button
                  type="button"
                  className="unsaved-discard"
                  disabled={busy === m.id}
                  onClick={() => void discard(m.id)}
                >
                  {t("unsavedDiscard")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * WHAT THE PERSON WAS DOING, in their words rather than the wire's.
 *
 * A verb kind is an implementation name (`mark_seen`, `triage_set`), and showing it would make the
 * one surface that exists to explain a failure the least explicable thing on screen.
 *
 * ── AN EXPLICIT MAP, NOT A COMPUTED KEY, AND THAT IS THE WHOLE POINT ───────────────────────
 *
 * The obvious spelling is `t(\`unsavedKind.\${kind}\`)`. It is wrong here in a way that only shows
 * up in production: next-intl THROWS `MISSING_MESSAGE` for a key it does not hold, so the first
 * time a verb without a string reaches this list the strip crashes — and the strip only renders
 * when something has already gone wrong, which is the worst possible moment to add a second
 * failure. A map keyed by a known kind cannot miss: an unlisted verb takes the generic sentence.
 *
 * Deliberately NOT `satisfies Record<MutationKind, string>`: that would make a new verb a COMPILE
 * error, which sounds stricter and is worse. It would put a translation chore in the path of every
 * verb anyone adds, and the pressure then is to write a filler string. Degrading to "a change to
 * your mailbox" is honest, and the fallback is exercised by the guard rather than assumed.
 */
const KIND_LABELS = new Map<string, string>(Object.entries({
  move: "unsavedKindMove",
  message_delete: "unsavedKindDelete",
  triage_set: "unsavedKindTriage",
  screener_decide: "unsavedKindScreener",
  mark_seen: "unsavedKindRead",
  feed_mark_seen: "unsavedKindRead",
  mail_send: "unsavedKindSend",
  draft_save: "unsavedKindDraft",
  draft_discard: "unsavedKindDraftDiscard",
  draft_accept: "unsavedKindDraft",
  draft_schedule_cancel: "unsavedKindSchedule",
  tag_assign: "unsavedKindTag",
  tag_create: "unsavedKindTag",
  tag_rename: "unsavedKindTag",
  tag_recolor: "unsavedKindTag",
  tag_delete: "unsavedKindTag",
  folder_create: "unsavedKindFolder",
  folder_rename: "unsavedKindFolder",
  folder_delete: "unsavedKindFolder",
  folder_op_dismiss: "unsavedKindFolder",
  rule_create: "unsavedKindRule",
  rule_update: "unsavedKindRule",
  rule_delete: "unsavedKindRule",
}));

function describe(m: AbandonedMutation, t: Translate): string {
  return t(KIND_LABELS.get(m.mutation.kind) ?? "unsavedKindOther");
}

/**
 * WHY IT FAILED — and an honest sentence when the server did not give one.
 *
 * An unhandled 500 answers `"internal error"`, which tells a person nothing and reads as if the app
 * is quoting itself. In that case this says what is actually known: the server refused it and did
 * not say why. Anything the server DID phrase for a human is passed through untouched.
 */
function reason(m: AbandonedMutation, t: Translate): string {
  const opaque = m.error.code === null
    || m.error.code === "internal"
    || m.error.message.trim() === "";
  return opaque ? t("unsavedNoReason") : m.error.message;
}
