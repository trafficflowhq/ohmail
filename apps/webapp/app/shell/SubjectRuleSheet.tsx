"use client";

/**
 * THE SUBJECT-RULE SHEET — pressing a message's title offers a rule with TWO terms.
 *
 * `chrome.openSubjectRule` has been a declared seam since the reading-surface slice, with the title
 * rendered as a heading-styled button and nothing behind it. This is what it opens.
 *
 * ── WHY THE TITLE IS THE RIGHT PLACE FOR IT ─────────────────────────────────────────────────
 *
 * The gesture people already have is "click the sender, change where their mail goes". This is the
 * same gesture one level finer: the thing on screen that distinguishes the invoice from the nightly
 * alert is the SUBJECT, so the subject is the control. The two sheets are deliberately siblings —
 * same popover box, same destination list, same honest footer — because they answer the same
 * question about different halves of one message.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────────────────────
 *
 *  · **No free-text box.** A box asking somebody to invent a substring gets `Alert` typed into it,
 *    which then also catches `Alert: your invoice is overdue`. It offers the DETECTED repeating
 *    token, and the message's own subject as the explicit alternative. Both are shown in full.
 *  · **No claim that mail moves back.** The rule is revocable at Settings → Rules, and revoking it
 *    does not un-file anything — `DELETE /rules/:id` touches the rules row and the change log and
 *    nothing else. So the way back offered here is the count and the choice BEFORE the press, which
 *    is the same construction `SenderMenu` uses and for the same reason.
 *  · **No second identical rule.** When one already files this address-and-term into the chosen
 *    pile, the sheet says so and writes nothing. A habit-press must not mint rows nobody can tell
 *    apart in the rules list.
 *
 * ── THE CONFIRM ROW STATES BOTH TERMS, AND THAT IS THE WHOLE POINT ──────────────────────────
 *
 * "from info@sichersatt.ch AND subject contains »[NinjaFirewall]« → Reads". A person about to narrow
 * a rule has to be able to read the conjunction, because the failure mode of this feature is a term
 * that is subtly wrong — one letter off, or looser than they think — and no toast afterwards can
 * repair a backlog that has already been re-filed.
 *
 * ── COPY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Read through a SHIM (`copy` below): `messages/en.json` wins the moment a key exists there and the
 * fallback wording is the same sentence. It is a shim with one exit, not a second source of copy —
 * the same device `MessagePane` uses, for the same reason.
 *
 * It reuses `sender-sheet.css` verbatim (`.senderm`, `.sm-*`) rather than adding a stylesheet: the
 * two sheets are siblings and a second set of nearly-identical rules is how they drift apart.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar, DECISION_DONE_LABEL, InfoNote } from "@ohmail/ui";
import { avatarHue, initialsOf } from "./format";
import "./sender-sheet.css";
import { RETRO_DEFAULT_ON, type ScreeningDest } from "./sender-screening";
import {
  SUBJECT_RULE_DESTS,
  bodyMatchCount,
  planSubjectRule,
  subjectMatchCount,
  type SubjectRuleContext,
  type TermField,
} from "./subject-rule";

export interface SubjectRuleState {
  /** The message whose title was pressed. */
  messageId: string;
  x: number;
  y: number;
}

/**
 * Which term the sheet is offering. Three choices and no text input:
 *
 *  · `token`   — the detected repeating token in the SUBJECT. Absent when nothing repeats.
 *  · `whole`   — this message's entire subject, which is always available and always exact.
 *  · `content` — the detected repeating token in the message TEXT (mail 0052). Absent when
 *                nothing repeats in the text the mirror holds. For the sender whose subjects are
 *                all alike and whose distinguishing text is in the body.
 *
 * `whole` is not a fallback nobody would pick: "everything with this exact subject" is a real thing
 * to want for a recurring report whose title never changes, and it is the honest offer when detection
 * has nothing. It is never the DEFAULT while a token exists, because a rule keyed on a whole subject
 * line catches less than the user usually means. `content` follows the same discipline as `token` —
 * detected, never typed — and a `null` detection simply does not render the option.
 */
type TermChoice = "token" | "whole" | "content";

export function SubjectRuleSheet({
  state,
  ctx,
  onConfirm,
  onClose,
}: {
  state: SubjectRuleState;
  ctx: SubjectRuleContext;
  onConfirm: (term: string, dest: ScreeningDest, field: TermField) => void;
  onClose: () => void;
}) {
  const t = useTranslations("screening");
  const rootRef = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<TermChoice>(ctx.token ? "token" : "whole");
  /** The destination awaiting its confirm press, or null. One question at a time. */
  const [pending, setPending] = useState<ScreeningDest | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    // `mousedown`, matching the sender sheet: a `click` listener would race the press that opened it.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  /**
   * A key that is not in `messages/en.json` yet falls back to the SAME wording here. `en.json` wins
   * the moment it exists, so this cannot become a second source of copy.
   */
  const copy = (key: string, reported: string): string => (t.has(key) ? t(key) : reported);

  const label = ctx.name || ctx.address;
  // The choice decides BOTH halves — the term and the field it reads — in one place, so the
  // radio, the plan and the confirm sentence cannot disagree about what is being written.
  const field: TermField = choice === "content" ? "body" : "subject";
  const term = (choice === "token" ? ctx.token : choice === "content" ? ctx.bodyToken : ctx.subject)
    ?? ctx.subject;
  // Computed through the SAME function the plan uses, so the number the sheet shows and the work that
  // happens cannot disagree — `SenderMenu`'s rule, applied here.
  const plan = planSubjectRule(ctx, term, pending ?? "reads", field);
  const tokenCount = ctx.token ? subjectMatchCount(ctx.messages, ctx.token) : 0;
  const wholeCount = subjectMatchCount(ctx.messages, ctx.subject);
  const contentCount = ctx.bodyToken ? bodyMatchCount(ctx.messages, ctx.bodyToken) : 0;

  return (
    <div
      ref={rootRef}
      className="senderm"
      role="dialog"
      aria-label={copy(
        "subjectAria",
        `Make a rule for mail from ${ctx.address} with this in the subject`,
      )}
      style={{ left: state.x, top: state.y }}
    >
      <div className="sm-head">
        <Avatar initials={initialsOf(label)} hue={avatarHue(ctx.address)} size="s" />
        <span className="sm-who">
          <b>{label}</b>
          {ctx.name ? <small>{ctx.address}</small> : null}
        </span>
      </div>

      <div className="sm-now">
        {copy(
          "subjectLead",
          "This sender sends more than one kind of mail. File just the ones whose subject matches.",
        )}
      </div>

      {/* ── THE TERM, AS A CHOICE OF TWO ─────────────────────────────────────────────────────
          ABOVE the destinations, because it changes what pressing one of them writes. It reuses
          `.sm-scope`'s styling for the reason that class exists: this is the same "pick the subject
          of the decision" control the sender sheet's address/domain switch is, one level finer. */}
      <div className="sm-scope" role="radiogroup" aria-label={copy("subjectTermAria", "Which subject term")}>
        {ctx.token ? (
          <button
            type="button"
            role="radio"
            aria-checked={choice === "token"}
            className={choice === "token" ? "on" : undefined}
            onClick={() => { setChoice("token"); setPending(null); }}
          >
            {`»${ctx.token}«`}
            {/* THE SIZE OF THE CHOICE, ON THE CHOICE — `SenderMenu`'s rule. The count is the same
                predicate the server will apply (a case-folded substring), so it is a measurement and
                not an estimate. It counts what this client has SYNCED, which is every message on the
                account (the mirror replays the whole change log), but the copy still says "of the
                mail here" rather than "every message": the server pass re-evaluates each one and a
                higher-priority rule can keep it where it is. */}
            <small>{copy("subjectTokenCount", `${tokenCount} of this sender's messages`)}</small>
          </button>
        ) : null}
        <button
          type="button"
          role="radio"
          aria-checked={choice === "whole"}
          className={choice === "whole" ? "on" : undefined}
          onClick={() => { setChoice("whole"); setPending(null); }}
        >
          {copy("subjectWhole", "This exact subject")}
          <small>{copy("subjectWholeCount", `${wholeCount} of this sender's messages`)}</small>
        </button>
        {/* ── THE CONTENT TERM (mail 0052) ─────────────────────────────────────────────────
            The same discipline as the subject token — detected, never typed — against the message
            TEXT, for the sender whose subjects are all alike. Rendered only when something repeats
            in the text the mirror holds. The count is over that same held text, which is a FLOOR
            of what the server will match ("of the mail here"), not the exact measurement the
            subject counts are — the copy says "here" for that reason. */}
        {ctx.bodyToken ? (
          <button
            type="button"
            role="radio"
            aria-checked={choice === "content"}
            className={choice === "content" ? "on" : undefined}
            onClick={() => { setChoice("content"); setPending(null); }}
          >
            {`»${ctx.bodyToken}«`}
            <small>
              {copy(
                "bodyTokenCount",
                `in the message text — ${contentCount} of this sender's messages here`,
              )}
            </small>
          </button>
        ) : null}
      </div>

      {/* NOTHING REPEATS, SAID OUT LOUD. Detection answering `null` is a normal outcome, and a sheet
          that silently offered only one option would leave the reader wondering what it looked for.
          It is a note and not a refusal: the exact-subject rule is still a real thing to write. */}
      {!ctx.token ? (
        <InfoNote
          className="sm-confirm-fine"
          lead={copy(
            "subjectNoToken",
            "No repeating tag was found in this sender's other subjects.",
          )}
          moreLabel={copy("subjectNoTokenMoreLabel", "What it looks for")}
        >
          {copy(
            "subjectNoTokenMore",
            "A tag in brackets, or a label before the first colon or dash, that also appears in "
              + "another message from the same sender. A phrase that occurs only once would file one "
              + "message and nothing else.",
          )}
        </InfoNote>
      ) : null}

      {/* ── THE CONFIRM, WHICH STATES BOTH TERMS ─────────────────────────────────────────────
          Not an "are you sure?" — the one moment at which the CONJUNCTION can be read before it is
          written. A term that is subtly wrong is this feature's failure mode, and nothing said
          afterwards repairs a backlog that has already been re-filed. */}
      {pending ? (
        <div className="sm-confirm">
          <p>
            {plan.field === "body"
              ? copy(
                  "bodyConfirm",
                  `from ${plan.match} AND the text contains »${plan.term}« → ${DECISION_DONE_LABEL[pending]}`,
                )
              : copy(
                  "subjectConfirm",
                  `from ${plan.match} AND subject contains »${plan.term}« → ${DECISION_DONE_LABEL[pending]}`,
                )}
          </p>
          <InfoNote
            className="sm-confirm-fine"
            lead={
              plan.already
                ? copy("subjectConfirmAlready", "You already have this rule. Nothing will be written.")
                : RETRO_DEFAULT_ON
                  ? copy(
                      "subjectConfirmFine",
                      `Applies to the ${plan.matched} matching message(s) already here as well as to `
                        + "future mail. Mail this moves stays moved if you revoke the rule later.",
                    )
                  : copy("subjectConfirmFineFuture", "Applies to future mail from this sender.")
            }
            moreLabel={copy("subjectConfirmMoreLabel", "What it does not do")}
          >
            {plan.field === "body"
              ? copy(
                  "bodyConfirmMore",
                  "The sender's other mail is untouched — this rule only names the messages whose text "
                    + "contains the term. It never says every message: a higher-priority rule can keep "
                    + "one where it is, and mail you have already filed by hand is left alone. Revoke "
                    + "or change it at Settings → Rules.",
                )
              : copy(
                  "subjectConfirmMore",
                  "The sender's other mail is untouched — this rule only names the messages whose subject "
                    + "matches. It never says every message: a higher-priority rule can keep one where it "
                    + "is, and mail you have already filed by hand is left alone. Revoke or change it at "
                    + "Settings → Rules.",
                )}
          </InfoNote>
          <span className="sm-confirm-row">
            <button
              type="button"
              className="go"
              onClick={() => { setPending(null); onConfirm(plan.term, pending, plan.field); }}
            >
              {copy("subjectConfirmGo", `File these to ${DECISION_DONE_LABEL[pending]}`)}
            </button>
            <button type="button" onClick={() => setPending(null)}>
              {copy("cancel", "Cancel")}
            </button>
          </span>
        </div>
      ) : (
        <ul role="listbox">
          {SUBJECT_RULE_DESTS.map((dest) => (
            <li
              key={dest}
              role="option"
              aria-selected={ctx.current === dest}
              className={ctx.current === dest ? "sel" : undefined}
              onClick={() => setPending(dest)}
            >
              {DECISION_DONE_LABEL[dest]}
              {ctx.current === dest ? <span className="ck">✓</span> : null}
            </li>
          ))}
        </ul>
      )}

      {/* ── THE FOOTER ───────────────────────────────────────────────────────────────────────
          Two true sentences. The first names what a rule with two terms does that a sender rule
          cannot; the second is the way back, and it is the count-and-choice kind rather than an undo,
          because revoking a rule moves no mail. When a rule with a term already exists for this
          address the footer says so — that is the state in which a second press is most likely to be
          a duplicate the user did not intend. */}
      <div className="sm-foot">
        {ctx.existing.length > 0
          ? copy(
              "subjectFootExisting",
              // "narrower", not "subject": the count includes body-term rules (mail 0052).
              `You already have ${ctx.existing.length} narrower rule(s) for this sender. See them at `
                + "Settings → Rules.",
            )
          : copy(
              "subjectFoot",
              "The sender's other mail keeps going where it goes now. Change or revoke this at "
                + "Settings → Rules.",
            )}
      </div>
    </div>
  );
}
