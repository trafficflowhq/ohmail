"use client";

/**
 * The sender's screening, as a popover reachable from any list or open message; anchored like the tag
 * picker, Escape and outside click dismiss. It states the consequence BEFORE the click, and the two
 * differ: from the Screener the change becomes a rule, from anywhere else it moves the mail only (see
 * `sender-screening.ts`). The additions sit around the existing sheet: a scope switch, offered only
 * when the address has a domain, defaulting to the ADDRESS — defaulting to the domain would silently
 * widen every existing click, and on a shared provider that is a mailbox-destroying gesture; the
 * counts are stated on the switch, so the wide option is chosen with its size visible. And a way into
 * the detail view — every message from this address or domain and why it sits there (`sender-audit.ts`).
 */

/**
 * A pre-click disclosure for the two reject destinations: screening a waiting sender out ALSO arms
 * auto-unsubscribe (the screener calls `onScreenOut` after the commit), so one click on a domain can
 * send one-click unsubscribe requests to every list under it. That is a CONFIRM, not a toast — a
 * sentence shown after the act is not a disclosure (the `RulesView` revoke construction). Since mail
 * 0054 it is also conditional on the account having left auto-unsubscribe on and on the build having
 * an unsubscribe service — see {@link autoUnsubscribe}: an empty confirm teaches people to click
 * through the real one.
 */

/**
 * The addition that changes the default: creating a rule also applies it to the mail already in the
 * mailbox, and that is the default. Choosing a destination for a sender PAST the gate writes a rule as
 * well as moving the mail (`rule_create`); the toggle is ON by default. Only offered for a sender the
 * Screener is NOT holding — a waiting sender's rule is promoted by `POST /screener/:id` inside the
 * decision itself. The rule path does NOT carry the unsubscribe disclosure, and that is checked, not
 * assumed: `unsubscribe.onScreenOut` has exactly one production caller (`screener-service.ts`,
 * `decide`'s reject branch) and `RulesService.create` calls nothing — a rule written past the gate
 * arms nothing today, so warning here would train people to click through the real confirm above.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar, InfoNote } from "@ohmail/ui";
import { usePileNames } from "./decision-copy";
import { avatarHue, initialsOf } from "./format";
import { displayAddress, displayAddressee, displayDomain } from "./idn";
import { useOverlayClamp } from "./overlay-clamp";
import { addressHref } from "./address-view";
import "./sender-sheet.css";
import {
  DECISION_OF_DEST,
  RETRO_DEFAULT_ON,
  SCREENING_DESTS,
  planScreeningChange,
  type ScreeningDest,
  type ScreeningScope,
  type SenderScreening,
} from "./sender-screening";

export interface SenderMenuState {
  /** Any message from the sender — the mirror resolves the rest. */
  messageId: string;
  /**
   * THE SUBJECT, when it is not the message's sender — a contact chip's To/Cc address
   * (viewer redesign). `senderScreening` resolves every fact from it instead of `from.address`,
   * and every dispatch off this sheet (`changeScreening`, `openSenderAudit`) must carry it
   * too, or the sheet would SHOW one person and rule on another. Absent for every opener
   * that predates chips: the sender resolves, byte for byte as before.
   */
  address?: string;
  x: number;
  y: number;
  /** The anchor's edges, for the viewport clamp — see `overlay-clamp.ts`. */
  anchorTop?: number;
  anchorBottom?: number;
}

export function SenderMenu({
  state,
  sender,
  onChoose,
  onOpenDetail,
  onSubjectRule,
  autoUnsubscribe = true,
  onClose,
}: {
  state: SenderMenuState;
  sender: SenderScreening;
  onChoose: (dest: ScreeningDest, scope: ScreeningScope, makeRule: boolean) => void;
  onOpenDetail: (scope: ScreeningScope) => void;
  /**
   * OPEN THE SUBJECT-RULE SHEET for this sender — the row below the detail link.
   *
   * OPTIONAL, so every existing mount of this component keeps compiling and simply does not offer
   * the row. That is the honest degradation rather than a dead control, and it is the same shape
   * `chrome.openSubjectRule` uses one layer up.
   */
  onSubjectRule?: () => void;
  /**
   * Will a screen-out actually send the one-click request? — the account switch (mail 0054) and the
   * build, ANDed one layer up (`AppShell#autoUnsubscribeDiscloses`). The second half of the
   * confirm's condition: `ScreeningPlan.unsubscribes` answers whether this PATH arms the mechanism
   * (a fact about the code); this answers whether the mechanism is armed at all (the account and
   * the deployment). Both must be true or the sheet asks consent for something that will not
   * happen. Defaults to TRUE — the default is the disclosure: an untaught mount keeps asking, and
   * the failure to avoid is the silent one, a stale caller dropping a warning about a request that
   * is still being sent.
   */
  autoUnsubscribe?: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("screening");
  /* The five pile names, from the Screener's namespace — the same words the rail and the
     decision bar use. See `decision-copy.ts`. */
  const piles = usePileNames();
  const rootRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<ScreeningScope>("sender");
  /** The reject destination awaiting its second click, or null. One question at a time. */
  const [confirm, setConfirm] = useState<ScreeningDest | null>(null);
  /** ON by default. The requirement is about the DEFAULT, not about offering an option. */
  const [makeRule, setMakeRule] = useState(true);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    // `mousedown` on the document, matching the tag picker: a `click` listener would race
    // the very click that opened this.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const label = displayAddressee(sender.name, sender.address);
  /**
   * THE ADDRESS AND DOMAIN AS THE COPY READS THEM — an internationalized domain decoded
   * (`idn.ts`). Every sentence in this menu is a promise about what a rule will do, and it should
   * name the sender the way the reader knows them. What the rule is WRITTEN from stays
   * `sender.address` / `sender.domain`, which is also what `avatarHue` keys on below.
   */
  const who = displayAddress(sender.address);
  const whichDomain = displayDomain(sender.domain);
  // Offered only when there IS a domain: `decide` answers 422 for an address with no `@`
  // (an empty `match` on a domain rule is compared against the empty domain of every other
  // malformed address), so the switch must not present a choice the server refuses.
  const canScope = sender.domain !== "";
  const subject = sender.scopes[scope];

  /**
   * Committing goes through `planScreeningChange` — the SAME function `AppShell` will call —
   * so the number this sheet shows and the work that happens cannot disagree. Computing it
   * here for the preview and there for the dispatch is one function evaluated twice, not two
   * implementations that agree today.
   */
  const preview = confirm ? planScreeningChange(sender, confirm, scope, makeRule) : null;

  const commit = (dest: ScreeningDest) => {
    // The disclosure is owed exactly when the wire will arm auto-unsubscribe AND the mechanism is
    // armed at all. `ScreeningPlan.unsubscribes` decides the first — the one place that condition
    // about the PATH lives — and {@link autoUnsubscribe} the second; see its note for why the two
    // are separate questions rather than one flag pushed down into the planner.
    if (autoUnsubscribe && planScreeningChange(sender, dest, scope, makeRule).unsubscribes) {
      setConfirm(dest);
      return;
    }
    onChoose(dest, scope, makeRule);
  };

  /**
   * THE VIEWPORT CLAMP. This sheet is ~580px tall and `placePicker`'s flip guessed 190,
   * so anchored to the LAST message of a thread — the default reading position — everything
   * below "Reads" rendered off-screen with no way to reach it. The hook re-places the box
   * against its measured height: below the anchor, flipped above it, or capped with an inner
   * scroll, but never past the viewport's edges. See `overlay-clamp.ts` for the geometry.
   */
  const style = useOverlayClamp(rootRef, state);

  return (
    <div
      ref={rootRef}
      className="senderm"
      role="dialog"
      aria-label={t("aria", { sender: who })}
      style={style}
    >
      <div className="sm-head">
        <Avatar initials={initialsOf(label)} hue={avatarHue(sender.address)} size="s" />
        <span className="sm-who">
          <b>{label}</b>
          {sender.name ? <small>{who}</small> : null}
        </span>
      </div>

      {canScope ? (
        <>
        <div className="sm-sec">{t("scopeAria")}</div>
        <div className="sm-scope" role="radiogroup" aria-label={t("scopeAria")}>
          {(["sender", "domain"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              className={scope === s ? "on" : undefined}
              onClick={() => { setScope(s); setConfirm(null); }}
            >
              {s === "sender" ? t("scopeAddress") : t("scopeDomain", { domain: whichDomain })}
              {/* THE SIZE OF THE CHOICE, ON THE CHOICE. Domain scope on a shared provider is
                  the foot-gun; "214 messages · 38 senders" is what makes that visible without
                  a blocklist nobody can maintain. */}
              <small>
                {s === "domain"
                  ? t("scopeCount", {
                      count: sender.scopes.domain.messages.length,
                      senders: sender.scopes.domain.senders,
                    })
                  : t("scopeCountOne", { count: sender.scopes.sender.messages.length })}
              </small>
            </button>
          ))}
        </div>
        </>
      ) : null}

      <div className="sm-now">
        {subject.current
          ? t("nowIn", {
              place: subject.current === "screener" ? t("placeScreener") : piles[subject.current],
              count: subject.messages.length,
            })
          : t("nowSpread", { count: subject.messages.length })}
      </div>

      {/* ── THE RULE, WHICH IS NOW THE DEFAULT ───────────────────────────────────────────
          ABOVE the destinations, because it changes what clicking one of them does and a
          control read afterwards is not a choice. Offered only past the gate: a waiting
          sender's rule is promoted by the decide itself, so a switch there would be a control
          that cannot change the outcome.

          It is a settings row — the label block left, the switch right, the note under — and
          the WHOLE row is the switch (`role="switch"` on the one button; the knob inside it is a
          drawing keyed off the row's own state), so a tap anywhere on the row turns the rule.
          `sm-rule` names it for a test without depending on order. */}
      {!subject.waiting ? (
        <button
          type="button"
          role="switch"
          aria-checked={makeRule}
          aria-label={t("ruleToggleAria")}
          className="sm-rule"
          onClick={() => setMakeRule((on) => !on)}
        >
          <span className="lab">
            <b>{t("ruleToggle")}</b>
            {/* The retroactive half, said before the click and with its size: the rule is applied to
                mail already on the server by a worker pass. It rides the SAME switch — turning the
                rule off is the opt-out, and `planScreeningChange` reports `retro: false` for every
                plan that writes no rule, so control and behaviour cannot come apart. It says "apply
                the rule to", never "move" or "every message": the pass re-evaluates through
                `evaluateRules` (a higher-priority deny rule keeps its mail) and skips anything the
                user already acted on — a promise about the outcome would be false for both. */}
            {makeRule && RETRO_DEFAULT_ON ? (
              <small>{t("ruleRetro", { count: subject.messages.length })}</small>
            ) : null}
          </span>
          <span className="switch" aria-hidden="true">
            <i />
          </span>
        </button>
      ) : null}

      <div className="sm-sec">{t("sectionWhere")}</div>

      {/* ── THE CONFIRM, WHICH CARRIES THE DISCLOSURE ──────────────────────────────────────
          Not an "are you sure?" — the user is sure. It is the one moment at which "this will
          also ask these senders to stop mailing you" can be READ, before it is true. */}
      {confirm && preview ? (
        <div className="sm-confirm">
          <p>
            {scope === "domain"
              ? t("unsubDomain", {
                  domain: whichDomain,
                  senders: preview.senders,
                  place: piles[confirm],
                })
              : t("unsubSender", { sender: who, place: piles[confirm] })}
          </p>
          {/* THE FINE PRINT, SPLIT ON WHAT A PERSON MUST READ BEFORE PRESSING.
              "Once, and there is no undo" is the irreversible part and it stays on screen with
              the disclosure shut. HOW the request travels — from our servers rather than the
              browser, and what happens to a sender with no unsubscribe link — is mechanism: it
              is worth having and it is worth having HERE, but it was three lines of 10.5px
              type between the sentence that says what will happen and the button that does it. */}
          <InfoNote
            className="sm-confirm-fine"
            lead={t("unsubFine")}
            moreLabel={t("unsubFineMoreLabel")}
          >
            {t("unsubFineMore")}
          </InfoNote>
          <span className="sm-confirm-row">
            <button type="button" className="go" onClick={() => { setConfirm(null); onChoose(confirm, scope, makeRule); }}>
              {t("unsubCommit")}
            </button>
            <button type="button" onClick={() => setConfirm(null)}>{t("cancel")}</button>
          </span>
        </div>
      ) : (
        <ul role="listbox" aria-label={t("aria", { sender: who })}>
          {SCREENING_DESTS.map((dest) => (
            <li
              key={dest}
              role="option"
              aria-selected={subject.current === dest}
              className={subject.current === dest ? "sel" : undefined}
              // Focusable and key-operable: the sheet opens from the `s` key, and an option a
              // keyboard cannot reach is the same defect as one rendered off-screen.
              tabIndex={0}
              onClick={() => commit(dest)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  commit(dest);
                }
              }}
            >
              {piles[dest]}
              {/* The two destinations that can send mail on your behalf are marked before you
                  reach them, not only in the confirm that follows. */}
              {DECISION_OF_DEST[dest] === "no" && subject.waiting ? (
                <span className="sm-warn" aria-hidden="true">↗</span>
              ) : null}
              {subject.current === dest ? <span className="ck">✓</span> : null}
            </li>
          ))}
        </ul>
      )}

      <div className="sm-links">
      <button type="button" className="sm-detail" onClick={() => onOpenDetail(scope)}>
        {t("auditOpen", { count: subject.messages.length })}
      </button>

      {/* Everything from and to this address — the address view (`#/address/<addr>`). On a list row
          and a stream card the address pixels are this sheet's own handle (`sender-hit.ts`), so this
          row is the one way from those surfaces into that view; the search result row and the
          reader's chips link directly. A LINK, not a verb: it opens a different question, so it sits
          with the ways onward, not among the destinations. A real `<a href>` — the hash is what the
          router reads — and the sheet closes on press. Address scope only: a domain has no page. */}
      {scope === "sender" ? (
        <a className="sm-detail" href={addressHref(sender.address)} onClick={onClose}>
          {t("addressOpen")}
        </a>
      ) : null}

      {/* Split this sender by subject — the row that admits this sheet's limit: everything above
          decides where ALL of an address's mail goes, and a sender who sends two kinds has no answer
          here. Offered only at address scope — a domain scope is wider, not finer, and the server
          refuses a subject term on a domain rule, so offering it would end in a 400. A LINK to the
          finer sheet, not a control that writes: it asks a different question, so it sits below the
          destinations with the detail link (`.sm-detail` for that reason). */}
      {onSubjectRule && scope === "sender" ? (
        <button type="button" className="sm-detail" onClick={onSubjectRule}>
          {t("subjectRuleOpen")}
        </button>
      ) : null}
      </div>

      {/* The footer's three true sentences. A Screener-held sender goes through the endpoint that
          promotes a rule. Past the gate the sentence follows the toggle — `footNoRule` became false
          the moment `rule_create` existed, so it is now what the opt-out says, still exactly true
          there. `footWillRule` states the outcome ("future mail files there too"), not the
          mechanism, because the footer cannot know which destination is about to be clicked: for a
          destination a rule already covers, nothing is written and only the outcome sentence stays
          true. The toast, which does know, names the difference — `screeningToast`. */}
      <div className="sm-foot">
        {subject.waiting
          ? scope === "domain"
            ? t("footRuleDomain", { domain: whichDomain })
            : t("footRule", { sender: who })
          : makeRule
            ? RETRO_DEFAULT_ON
              // The sentence that used to promise only the future. It now names the
              // past as well, AND the thing that has no undo — mail this moves stays moved when
              // the rule is later revoked, because `DELETE /rules/:id` touches the rules row and
              // nothing else. Saying so here is the "way back" this feature actually has: the
              // count and the choice, before the click.
              ? scope === "domain"
                ? t("footWillRuleRetroDomain", { domain: whichDomain })
                : t("footWillRuleRetro", { sender: who })
              : scope === "domain"
                ? t("footWillRuleDomain", { domain: whichDomain })
                : t("footWillRule", { sender: who })
            : t("footNoRule")}
      </div>
    </div>
  );
}
