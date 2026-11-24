"use client";

/** Pick a term and a destination before making a sender rule. The rule planner owns all writes. */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Switch } from "@ohmail/ui/base";
import { ContactCardHeader, ContactDestinations } from "@ohmail/ui/mail";
import { TextField } from "@ohmail/ui/text-field";
import { usePileNames } from "../shell/decision-copy";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useOverlayFit } from "./overlay-clamp";
import { useFocusFollows } from "@ohmail/app-logic/keys/focus-follows";
import { SheetClose } from "./SheetClose";
import "../shell/sender-sheet.css";
import "./subject-rule-sheet.css";
import { RETRO_DEFAULT_ON, type ScreeningDest } from "@ohmail/app-logic/press/sender-screening";
import {
  MAX_SUBJECT_TERM_CHARS,
  SUBJECT_RULE_DESTS,
  bodyMatchCount,
  planSubjectRule,
  subjectMatchCount,
  subjectOrganizerMissing,
  type SubjectRuleContext,
  type TermField,
} from "@ohmail/app-logic/press/subject-rule";

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
  nobody = false,
  onConfirm,
  onClose,
  onBack = onClose,
}: {
  state: SubjectRuleState;
  ctx: SubjectRuleContext;
  /**
   * Nothing organizes the sender's mailbox (`otherOrganizerOf`): the confirm says so in place of what
   * the rule would file, and the line stands above the foot, as on the sender sheet.
   */
  nobody?: boolean;
  onConfirm: (term: string, dest: ScreeningDest, field: TermField, applyRetro: boolean) => void;
  onClose: () => void;
  onBack?: () => void;
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
  /**
   * Whether the rule also reaches the mail already filed — the sender sheet's second switch, here
   * too, because a narrowed rule has the same past as a broad one and the same answer must be
   * sayable. On by default (`RETRO_DEFAULT_ON`), and it rides the confirm so the row it changes is
   * the one the person is reading.
   */
  const [applyRetro, setApplyRetro] = useState(RETRO_DEFAULT_ON);

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

  /** The sender as the sheet's sentences read them — see `idn.ts`. `ctx.address` writes the rule. */
  const who = displayAddress(ctx.address);
  // The choice decides BOTH halves — the term and the field it reads — in one place, so the
  // radio, the plan and the confirm sentence cannot disagree about what is being written.
  const field: TermField = choice === "content" ? "body" : "subject";
  const term = (choice === "token" ? ctx.token : choice === "content" ? ctx.bodyToken : custom)
    ?? custom;
  // Computed through the SAME function the plan uses, so the number the sheet shows and the work that
  // happens cannot disagree — `SenderMenu`'s rule, applied here.
  const plan = planSubjectRule(ctx, term, pending ?? "reads", field, applyRetro);
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
  const { style, full } = useOverlayFit(rootRef, state);
  useFocusFollows(rootRef, { enter: "root", onEscape: onClose });

  return (
    <div
      ref={rootRef}
      className={full ? "senderm subject-rule-card sm-full" : "senderm subject-rule-card"}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      aria-label={t("subjectAria")}
      aria-description={who}
      data-full={full ? "" : undefined}
      style={style}
    >
      {/* The sender sheet's way out, for the same reason: see `SenderMenu`. */}
      <SheetClose full={full} label={t("auditClose")} onClose={onClose} />
      <div className="subject-rule-head">
        <ContactCardHeader
          heading
          title={t("cardSubject")}
          note={who}
          lead={<Button kind="quiet" size="s" icon="back" label={t("cardBack")} onPress={onBack} />}
        />
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
            placeholder={t("subjectTermPlaceholder")}
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

      <ContactDestinations
        note={term.trim() === "" ? undefined : t("subjectMatches", { count: plan.matched, total: ctx.messages.length })}
        goes={{
          label: t("cardGoesTo"),
          value: pending ?? undefined,
          places: SUBJECT_RULE_DESTS.map((dest) => ({
            value: dest,
            label: dest === "screened" ? t("cardScreenOut") : piles[dest],
          })),
          onChange: (value) => setPending(SUBJECT_RULE_DESTS.find((dest) => dest === value) ?? null),
        }}
      />
      {plan.already && pending !== null ? (
        <p className="sm-org" role="status">{t("subjectConfirmAlready")}</p>
      ) : nobody ? (
        <p className="sm-org" role="status">{t(subjectOrganizerMissing)}</p>
      ) : null}
      {!(plan.already && pending !== null) ? (
        <label className="subject-rule-switch">
          <span aria-hidden="true">{t("cardExisting")}</span>
          <Switch label={t("retroToggleAria")} on={applyRetro} onChange={setApplyRetro} />
        </label>
      ) : null}
      <div className="subject-rule-actions">
        <Button
          size="s"
          disabled={!pending || (!plan.already && plan.ruleMutations.length === 0)}
          onPress={() => {
            if (pending) onConfirm(plan.term, pending, plan.field, applyRetro);
          }}
        >
          {t("subjectMakeRule")}
        </Button>
        <Button kind="quiet" size="s" onPress={onBack}>{t("cancel")}</Button>
      </div>
    </div>
  );
}
