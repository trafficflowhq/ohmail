"use client";

/**
 * The subject-rule sheet — pressing a message's title offers a rule with two terms. The gesture
 * people have is "click the sender, change where their mail goes"; this is the same gesture one
 * level finer, and the two sheets are deliberate siblings (same popover box, destination list and
 * honest footer — it reuses `sender-sheet.css` verbatim, because a second set of nearly-identical
 * rules is how siblings drift). The confirm row states both terms ("from … AND subject contains …
 * → Reads"): the failure mode is a term subtly wrong, and no toast can repair a re-filed backlog.
 * Copy reads through a shim with one exit — `messages/en.json` wins the moment a key exists.
 */

/**
 * What it refuses: no BLIND free text — the exact-subject option is an editable match field (owner
 * request 2026-08-26) whose count re-runs the server's own test per keystroke and says out loud
 * when the fragment stops narrowing (matching ALL of the sender's mail here, or none); the
 * detected token is still offered first and never typed. No claim that mail moves back — revoking
 * a rule un-files nothing (`DELETE /rules/:id` touches the rules row and the change log), so the
 * way back is the count and the choice BEFORE the press. No second identical rule — the sheet says
 * so and writes nothing: a habit-press must not mint rows nobody can tell apart.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar, InfoNote, TextField } from "@ohmail/ui";
import { usePileNames } from "./decision-copy";
import { avatarHue, initialsOf } from "./format";
import { displayAddress, displayAddressee, displayRuleMatch } from "./idn";
import { useOverlayClamp } from "./overlay-clamp";
import "./sender-sheet.css";
import { RETRO_DEFAULT_ON, type ScreeningDest } from "./sender-screening";
import {
  MAX_SUBJECT_TERM_CHARS,
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
  /** The anchor's edges, for the viewport clamp — see `overlay-clamp.ts`. */
  anchorTop?: number;
  anchorBottom?: number;
}

/**
 * Which term the sheet is offering. `token` — the detected repeating token in the SUBJECT, absent
 * when nothing repeats. `whole` — the EDITABLE subject match, prefilled with the entire subject:
 * untouched it is "this exact subject", trimmed it is the manual door (owner request 2026-08-26);
 * the count under it is live — the same case-folded substring test the server applies — and the
 * field says plainly when the fragment matches ALL of the sender's mail here or NONE of it.
 * `content` — the detected token in the message TEXT (mail 0052), for the sender whose subjects are
 * all alike. `whole` is never the default while a token exists — a whole-subject rule catches less
 * than the user usually means; `content` keeps the detected-never-typed discipline.
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
  /**
   * The editable subject match — prefilled with the FULL subject, so the untouched field IS
   * "this exact subject" and every deletion widens the rule from there. State is initialized
   * once per mount; the shell keys this sheet by message id, so a different title press gets a
   * fresh prefill rather than the previous message's edit.
   */
  const [custom, setCustom] = useState<string>(ctx.subject);
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

  /* The five pile names as the catalogue has them — the same words the rail, the decision bar
     and the sender sheet use. See `decision-copy.ts`. */
  const piles = usePileNames();

  const label = displayAddressee(ctx.name, ctx.address);
  /** The sender as the sheet's sentences read them — see `idn.ts`. `ctx.address` writes the rule. */
  const who = displayAddress(ctx.address);
  // The choice decides BOTH halves — the term and the field it reads — in one place, so the
  // radio, the plan and the confirm sentence cannot disagree about what is being written.
  const field: TermField = choice === "content" ? "body" : "subject";
  const term = (choice === "token" ? ctx.token : choice === "content" ? ctx.bodyToken : custom)
    ?? custom;
  // Computed through the SAME function the plan uses, so the number the sheet shows and the work that
  // happens cannot disagree — `SenderMenu`'s rule, applied here.
  const plan = planSubjectRule(ctx, term, pending ?? "reads", field);
  const tokenCount = ctx.token ? subjectMatchCount(ctx.messages, ctx.token) : 0;
  // LIVE, against the edited value — the same case-folded substring test the server applies, so
  // the number tracks every keystroke and cannot disagree with the rule it measures.
  const customTrimmed = custom.trim();
  const customCount = subjectMatchCount(ctx.messages, custom);
  const contentCount = ctx.bodyToken ? bodyMatchCount(ctx.messages, ctx.bodyToken) : 0;
  /**
   * The two honest failure states of a typed fragment, said where the typing happens:
   *  · it matches EVERY one of the sender's messages here — the rule stopped narrowing and is a
   *    plain sender rule wearing a subject term (stated only when there is more than one message,
   *    because "1 of 1" is not evidence of anything);
   *  · it matches NONE — a fragment (or an emptied field) that names no mail.
   */
  const customAll = customTrimmed !== "" && ctx.messages.length > 1
    && customCount === ctx.messages.length;
  const customNone = customCount === 0;
  /**
   * Over the SERVER's own cap (`MAX_SUBJECT_TERM_CHARS` mirrors `RulesService`): the wire would
   * answer 400, the sheet would close, and the edit would be lost — so the state is said here
   * and the commit is withheld (`planSubjectRule` answers an over-cap term with zero mutations,
   * moves included). Reachable by paste and by a genuinely enormous prefilled subject; the
   * field is deliberately NOT truncated, because a silently shortened term is a different rule.
   */
  const customTooLong = customTrimmed.length > MAX_SUBJECT_TERM_CHARS;

  /**
   * THE VIEWPORT CLAMP — the sender sheet's sibling geometry. At ~600px this sheet
   * clipped its bottom 339px off a 1440×900 viewport when opened low, which put its lower
   * destinations out of reach entirely. Same hook, same rule: flip, cap, scroll — never clip.
   */
  const style = useOverlayClamp(rootRef, state);

  return (
    <div
      ref={rootRef}
      className="senderm"
      role="dialog"
      aria-label={t("subjectAria", { who })}
      style={style}
    >
      <div className="sm-head">
        <Avatar initials={initialsOf(label)} hue={avatarHue(ctx.address)} size="s" />
        <span className="sm-who">
          <b>{label}</b>
          {ctx.name ? <small>{who}</small> : null}
        </span>
      </div>

      <div className="sm-now">
        {t("subjectLead")}
      </div>

      {/* ── THE TERM, AS A CHOICE OF TWO ─────────────────────────────────────────────────────
          ABOVE the destinations, because it changes what pressing one of them writes. It reuses
          `.sm-scope`'s styling for the reason that class exists: this is the same "pick the subject
          of the decision" control the sender sheet's address/domain switch is, one level finer. */}
      <div className="sm-scope" role="radiogroup" aria-label={t("subjectTermAria")}>
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
            <small>{t("subjectTokenCount", { count: tokenCount })}</small>
          </button>
        ) : null}
        {/* ── THE EDITABLE MATCH (owner request 2026-08-26) ────────────────────────────────
            Prefilled with the FULL subject — untouched it is "this exact subject", trimmed it is
            the manual fragment the detection could not offer. A div with the radio role rather
            than a button, because a button swallows the text field inside it; focusing or typing
            in the field selects the choice, exactly as pressing the row does. The count is the
            live measurement; the two warnings below it are the honest failure states of a typed
            fragment, stated before anything can be written. */}
        {/* The radio proper is its own small control (the lead line) and the field is a LABELED
            TEXTBOX beside it, never a textbox inside a radio: a radio is an atomic widget, and a
            focusable descendant inside one is flattened or half-announced by screen readers.
            Focusing or editing the field selects the choice exactly as pressing
            the radio does; the count and the warnings live in one `role="status"` region the
            field is described by, so the safety feedback is HEARD while focus stays in it. */}
        <div
          className={choice === "whole" ? "sm-edit on" : "sm-edit"}
          onClick={() => { setChoice("whole"); setPending(null); }}
        >
          <button
            type="button"
            role="radio"
            aria-checked={choice === "whole"}
            className="sm-edit-pick"
            onClick={() => { setChoice("whole"); setPending(null); }}
          >
            {t("subjectEditLead")}
          </button>
          <TextField
            shape="line"
            type="text"
            className="sm-edit-input"
            value={custom}
            aria-label={t("subjectEditAria")}
            aria-describedby="sm-edit-status"
            spellCheck={false}
            onFocus={() => { setChoice("whole"); setPending(null); }}
            onChange={(e) => { setCustom(e.target.value); setChoice("whole"); setPending(null); }}
          />
          <span className="sm-edit-status" id="sm-edit-status" role="status">
            <small>
              {t("subjectWholeCount", { count: customCount })}
            </small>
            {choice === "whole" && customTooLong ? (
              <small className="sm-edit-warn">
                {t("subjectEditTooLong", { max: MAX_SUBJECT_TERM_CHARS })}
              </small>
            ) : null}
            {choice === "whole" && customAll ? (
              <small className="sm-edit-warn">
                {t("subjectEditAll")}
              </small>
            ) : null}
            {choice === "whole" && customNone ? (
              <small className="sm-edit-warn">
                {customTrimmed === ""
                  ? t("subjectEditEmpty")
                  : t("subjectEditNone")}
              </small>
            ) : null}
          </span>
        </div>
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
              {t("bodyTokenCount", { count: contentCount })}
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
          lead={t("subjectNoToken")}
          moreLabel={t("subjectNoTokenMoreLabel")}
        >
          {t("subjectNoTokenMore")}
        </InfoNote>
      ) : null}

      {/* ── THE CONFIRM, WHICH STATES BOTH TERMS ─────────────────────────────────────────────
          Not an "are you sure?" — the one moment at which the CONJUNCTION can be read before it is
          written. A term that is subtly wrong is this feature's failure mode, and nothing said
          afterwards repairs a backlog that has already been re-filed. */}
      {pending ? (
        <div className="sm-confirm">
          <p>
            {t(plan.field === "body" ? "bodyConfirm" : "subjectConfirm", {
              match: displayRuleMatch(plan.match),
              term: plan.term,
              dest: piles[pending],
            })}
          </p>
          <InfoNote
            className="sm-confirm-fine"
            lead={
              plan.already
                ? t("subjectConfirmAlready")
                : RETRO_DEFAULT_ON
                  ? t("subjectConfirmFine", { count: plan.matched })
                  : t("subjectConfirmFineFuture")
            }
            moreLabel={t("subjectConfirmMoreLabel")}
          >
            {t(plan.field === "body" ? "bodyConfirmMore" : "subjectConfirmMore")}
          </InfoNote>
          <span className="sm-confirm-row">
            <button
              type="button"
              className="go"
              /* An EMPTIED match field names no mail and writes no rule (`planSubjectRule`
                 answers it with zero mutations), so the press is withheld rather than confirmed
                 into a no-op. `plan.already` stays pressable — its press is the honest "nothing
                 will be written" the fine print above has already stated. */
              disabled={!plan.already && plan.ruleMutations.length === 0}
              onClick={() => { setPending(null); onConfirm(plan.term, pending, plan.field); }}
            >
              {t("subjectConfirmGo", { dest: piles[pending] })}
            </button>
            <button type="button" onClick={() => setPending(null)}>
              {t("cancel")}
            </button>
          </span>
        </div>
      ) : (
        <ul
          role="listbox"
          aria-label={t("subjectAria", { who })}
        >
          {SUBJECT_RULE_DESTS.map((dest) => (
            <li
              key={dest}
              role="option"
              aria-selected={ctx.current === dest}
              className={ctx.current === dest ? "sel" : undefined}
              // Focusable and key-operable, matching `SenderMenu`'s destinations: an option a
              // keyboard cannot reach is the same defect as one rendered off-screen.
              tabIndex={0}
              onClick={() => setPending(dest)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPending(dest);
                }
              }}
            >
              {piles[dest]}
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
        {/* "narrower", not "subject": the count includes body-term rules. */}
        {ctx.existing.length > 0
          ? t("subjectFootExisting", { count: ctx.existing.length })
          : t("subjectFoot")}
      </div>
    </div>
  );
}
