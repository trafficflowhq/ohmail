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
 * well as moving the mail (`rule_create`); the toggle is ON by default. The rule toggle is only
 * offered for a sender the Screener is NOT holding — a waiting sender's rule is promoted by
 * `POST /screener/:id` inside the decision itself. The rule path does NOT carry the unsubscribe
 * disclosure, checked not assumed: `unsubscribe.onScreenOut` has one production caller
 * (`screener-service.ts`, `decide`'s reject branch) and `RulesService.create` calls nothing, so
 * warning here would train people to click through the real confirm above.
 */

/**
 * THE PAST IS ITS OWN QUESTION (0.19). It rode the rule toggle, so keeping old mail where it was
 * meant abandoning the rule — the opposite of the choice asked for. A second switch under the rule,
 * on by default, offered at the gate too: there the rule is a given and the backlog is all that is
 * left to decide.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslations } from "next-intl";
import {
  VIEW_OF_FOLDER, type ConflictGroup, type Folder, type PressForecast, type RuleDTO, type RulesInPlay,
} from "@ohmail/client-engine";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { Avatar, InfoNote, Kbd } from "@ohmail/ui";
import { usePileNames } from "./decision-copy";
import { avatarHue, initialsOf, placeLabel } from "./format";
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
  type ScreeningPlace,
  type ScreeningPress,
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
  forecastFor,
  rulesFor,
  organizer,
  backRef,
  onClose,
}: {
  state: SenderMenuState;
  sender: SenderScreening;
  onChoose: (
    dest: ScreeningDest,
    scope: ScreeningScope,
    makeRule: boolean,
    applyRetro: boolean,
    press?: ScreeningPress,
  ) => void;
  /**
   * THE PRESS, BEFORE IT IS MADE — where the list would show the subject's mail after it
   * (`press-forecast.ts`). Absent or `null` (the demo): no step is asked and the press commits.
   */
  forecastFor?: (dest: ScreeningDest, scope: ScreeningScope, makeRule: boolean, applyRetro: boolean) => PressForecast | null;
  /** "Their rules": every rule deciding the subject's mail today, as the list places it. */
  rulesFor?: (scope: ScreeningScope) => RulesInPlay | null;
  /** Another install organizes the subject's mailbox: a rule made here is made on its next pass. */
  organizer?: { name: string | null } | undefined;
  /** Where the shell's Escape asks the sheet to step back before closing it. */
  backRef?: MutableRefObject<(() => boolean) | null>;
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
  /** The sheet's step: the list, the resolve step over rules that disagree, or the unsubscribe
      confirm. One question at a time; Escape steps back to the list before it closes the sheet. */
  const [step, setStep] = useState<SheetStep>({ kind: "list" });
  const confirm = step.kind === "unsubscribe" ? step.dest : null;
  /** The destination that opened the step, so stepping back returns focus to it. */
  const openedFrom = useRef<ScreeningDest | null>(null);
  /** ON by default. The requirement is about the DEFAULT, not about offering an option. */
  const [makeRule, setMakeRule] = useState(true);
  /**
   * …and whether that rule also reaches the mail already filed — the SECOND question, which used
   * to ride the first. Same default, on; separate state, because "file their future mail there
   * and leave my old mail alone" was unsayable while the only opt-out was abandoning the rule.
   */
  const [applyRetro, setApplyRetro] = useState(RETRO_DEFAULT_ON);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    // `mousedown` on the document, matching the tag picker: a `click` listener would race
    // the very click that opened this.
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  /** Back to the list, focus on the destination that opened the step. `false` on the list. */
  const refocus = useRef<ScreeningDest | null>(null);
  const stepBack = (): boolean => {
    if (step.kind === "list") return false;
    refocus.current = openedFrom.current;
    setStep({ kind: "list" });
    return true;
  };
  useEffect(() => {
    if (step.kind !== "list" || refocus.current === null) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-dest="${refocus.current}"]`)?.focus();
    refocus.current = null;
  }, [step]);
  useEffect(() => {
    if (!backRef) return undefined;
    backRef.current = stepBack;
    return () => { backRef.current = null; };
  });

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
  const inPlay = rulesFor?.(scope) ?? null;
  /** A place the lists show mail in, by the names the rail uses. */
  const placeName = (p: ScreeningPlace): string =>
    p === "screener" ? t("placeScreener") : p === "history" ? t("placeHistory") : piles[p];
  /** A rule's destination by the same names; a folder of the user's own by its leaf. */
  const pileOf = (folder: Folder | null): string => {
    if (folder === null) return t("placeHistory");
    const view = VIEW_OF_FOLDER[canonicalDestination(folder) as Folder];
    return view && view in piles ? piles[view as ScreeningDest] : view === "screener" ? t("placeScreener") : placeLabel(folder);
  };
  /** What a rule claims — all of an address's mail, a subject or text term, or a whole domain. */
  const conditionOf = (r: RuleDTO): string => {
    if (r.kind === "domain") return t("scopeDomain", { domain: displayDomain(r.match) });
    // At domain scope an address rule is somebody's own: named by the address it is about.
    if (scope === "domain") return displayAddress(r.match);
    const subjectTerm = (r.subjectContains ?? "").trim();
    if (subjectTerm) return t("ruleSubject", { term: subjectTerm });
    const bodyTerm = (r.bodyContains ?? "").trim();
    if (bodyTerm) return t("ruleBody", { term: bodyTerm });
    return t("ruleAll");
  };

  /**
   * Committing goes through `planScreeningChange` — the SAME function `AppShell` will call —
   * so the number this sheet shows and the work that happens cannot disagree. Computing it
   * here for the preview and there for the dispatch is one function evaluated twice, not two
   * implementations that agree today.
   */
  const preview = confirm ? planScreeningChange(sender, confirm, scope, makeRule, applyRetro) : null;

  const commit = (dest: ScreeningDest) => {
    // The disclosure is owed exactly when the wire will arm auto-unsubscribe AND the mechanism is
    // armed at all. `ScreeningPlan.unsubscribes` decides the first — the one place that condition
    // about the PATH lives — and {@link autoUnsubscribe} the second; see its note for why the two
    // are separate questions rather than one flag pushed down into the planner.
    const unsubscribes = autoUnsubscribe && planScreeningChange(sender, dest, scope, makeRule, applyRetro).unsubscribes;
    /* A RULE THAT DISAGREES IS ASKED ABOUT FIRST — only when the press writes one (or decides at
       the gate) and the forecast finds a rule keeping mail elsewhere, or an exception to write. */
    const asks = makeRule || subject.waiting;
    const forecast = asks ? forecastFor?.(dest, scope, makeRule, applyRetro) ?? null : null;
    const cls = forecast ? stepClass(forecast, scope) : null;
    if (forecast && cls) {
      openedFrom.current = dest;
      setStep({ kind: "resolve", dest, forecast, cls, choice: defaultChoice(cls, forecast), unsubscribes });
      return;
    }
    if (unsubscribes) {
      openedFrom.current = dest;
      setStep({ kind: "unsubscribe", dest });
      return;
    }
    onChoose(dest, scope, makeRule, applyRetro);
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
              onClick={() => { setScope(s); setStep({ kind: "list" }); }}
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
          ? t("nowIn", { place: placeName(subject.current), count: subject.messages.length })
          : subject.places.length >= 2 && subject.places.length <= 3
            // Two or three places are named, each with its count; four or more stay "spread".
            ? t("nowSplit", {
                count: subject.messages.length,
                places: subject.places.map((p) => t("nowSplitPart", { place: placeName(p.place), count: p.count })).join(" · "),
              })
            : t("nowSpread", { count: subject.messages.length })}
      </div>

      {inPlay?.worthShowing ? (
        <div className="sm-rules">
          <div className="sm-rules-head">{t("rulesHead")}</div>
          {inPlay.lines.slice(0, 3).map((line) => (
            <RuleLineRow key={line.rules[0]!.id} rules={line.rules} count={line.count} condition={conditionOf} pile={pileOf} />
          ))}
          {inPlay.inside ? (
            <div className="sm-rule-line">
              <span className="cond">{t("ruleInside", { senders: inPlay.inside.senders })}</span>
              <span className="n">{inPlay.inside.count}</span>
            </div>
          ) : null}
          {inPlay.lines.length > 3 ? (
            <div className="sm-rules-more">{t("rulesMore", { count: inPlay.lines.length - 3 })}</div>
          ) : null}
        </div>
      ) : null}

      {/* ── THE RULE, WHICH IS NOW THE DEFAULT ───────────────────────────────────────────
          ABOVE the destinations, because it changes what clicking one of them does and a
          control read afterwards is not a choice. Offered only past the gate: a waiting
          sender's rule is promoted by the decide itself, so a switch there would be a control
          that cannot change the outcome. The PAST-mail row below is offered in both places,
          because that answer changes the outcome at the gate as well.

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
          </span>
          <span className="switch" aria-hidden="true">
            <i />
          </span>
        </button>
      ) : null}

      {/* ── AND WHETHER IT REACHES THE MAIL ALREADY HERE ─────────────────────────────────
          A second row, indented under the rule, because it is a question ABOUT the rule and not a
          peer of it. Offered whenever a rule will be in force — past the gate that means the switch
          above is on; at the gate the decide promotes one regardless, so this is the only answer
          left to give, and it is the only door to a decided sender's mail that has already left the
          Screener.

          The note states the SIZE with the mirror's own honesty (`auditCount`'s grammar): the count
          is what this install has synced, and the pass walks what is on the server. The count is
          never phrased as a promise that they all move — the pass re-evaluates through
          `evaluateRules` and skips what the user acted on; the footer states the leave-alone set. */}
      {subject.waiting || makeRule ? (
        <button
          type="button"
          role="switch"
          aria-checked={applyRetro}
          aria-label={t("retroToggleAria")}
          className="sm-retro"
          onClick={() => setApplyRetro((on) => !on)}
        >
          <span className="lab">
            <b>{t("retroToggle")}</b>
            <small>{t("retroToggleNote", { count: subject.messages.length })}</small>
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
      {step.kind === "resolve" ? (
        <ResolveStep
          step={step}
          scope={scope}
          place={piles[step.dest]}
          domain={whichDomain}
          domainSenders={sender.scopes.domain.senders}
          domainCount={sender.scopes.domain.messages.length}
          condition={conditionOf}
          pile={pileOf}
          unsubscribeSentence={step.unsubscribes
            ? scope === "domain"
              ? t("unsubDomain", { domain: whichDomain, senders: sender.scopes.domain.senders, place: piles[step.dest] })
              : t("unsubSender", { sender: who, place: piles[step.dest] })
            : null}
          onChoice={(choice) => setStep({ ...step, choice })}
          onCommit={() => {
            const tile = tilesOf(step.cls, step.forecast, step.choice);
            setStep({ kind: "list" });
            onChoose(step.dest, tile.scope ?? scope, makeRule, applyRetro, {
              resolution: tile.resolution, shown: step.forecast.groups.map((g) => g.rule), forecast: step.forecast,
            });
          }}
          onCancel={() => { stepBack(); }}
        />
      ) : confirm && preview ? (
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
            <button type="button" className="go" onClick={() => { setStep({ kind: "list" }); onChoose(confirm, scope, makeRule, applyRetro); }}>
              {t("unsubCommit")}
            </button>
            <button type="button" onClick={() => { stepBack(); }}>{t("cancel")} <Kbd>esc</Kbd></button>
          </span>
        </div>
      ) : (
        <ul role="listbox" aria-label={t("aria", { sender: who })}>
          {SCREENING_DESTS.map((dest) => (
            <li
              key={dest}
              data-dest={dest}
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
      {organizer && (makeRule || subject.waiting) ? (
        <div className="sm-org">
          {organizer.name ? t("orgPending", { name: organizer.name }) : t("orgPendingUnnamed")}
        </div>
      ) : null}

      <div className="sm-foot">
        {/* One sentence per pair of answers — (a rule, the past) at the gate and past it. The
            retroactive arm names the past AND the thing that has no undo: mail this moves stays
            moved when the rule is later revoked, because `DELETE /rules/:id` touches the rules row
            and nothing else. It says "the mail ohmail has already filed for you" rather than "the
            mail already in your mailbox", which was wider than the pass: only the six folders
            ohmail organizes are candidates, so a customer's own folders and their Sent are never
            touched. */}
        {subject.waiting
          ? applyRetro
            ? scope === "domain"
              ? t("footRuleRetroDomain", { domain: whichDomain })
              : t("footRuleRetro", { sender: who })
            : scope === "domain"
              ? t("footRuleDomain", { domain: whichDomain })
              : t("footRule", { sender: who })
          : makeRule
            ? applyRetro
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

/** The sheet's step. `resolve` carries the forecast it asks over and the tile chosen. */
type SheetStep =
  | { kind: "list" }
  | { kind: "unsubscribe"; dest: ScreeningDest }
  | {
      kind: "resolve"; dest: ScreeningDest; forecast: PressForecast; cls: StepClass; choice: 0 | 1;
      /** The press also arms auto-unsubscribe: its sentence stands under the rule question. */
      unsubscribes: boolean;
    };

/** Which question the step asks: a term rule of theirs, a domain rule above the address, or the
    people inside a domain with rules of their own. */
type StepClass = "term" | "domain" | "inside";

const isTerm = (g: ConflictGroup) => g.cause === "term-subject" || g.cause === "term-body";

function stepClass(f: PressForecast, scope: ScreeningScope): StepClass | null {
  if (scope === "sender" && f.groups.some(isTerm)) return "term";
  if (scope === "sender" && (f.exception !== null || f.groups.some((g) => g.cause === "domain-outranks"))) return "domain";
  if (scope === "domain" && f.groups.some((g) => g.cause === "own-rule-inside")) return "inside";
  return null;
}

/** The press wins over their own term rule; their own address rules inside a domain stay. */
function defaultChoice(cls: StepClass, f: PressForecast): 0 | 1 {
  if (cls === "domain") return f.exception ? 0 : 1;
  return 0;
}

/** What each tile answers: the resolution, and a scope when the tile widens the press. */
function tilesOf(cls: StepClass, f: PressForecast, choice: 0 | 1): { resolution: "remove" | "keep"; scope?: ScreeningScope } {
  const tiles: Array<{ resolution: "remove" | "keep"; scope?: ScreeningScope }> =
    cls === "term" ? [{ resolution: "remove" }, { resolution: "keep" }]
      : cls === "inside" ? [{ resolution: "keep" }, { resolution: "remove" }]
        : f.exception ? [{ resolution: "keep" }, { resolution: "keep", scope: "domain" }]
          : [{ resolution: "keep", scope: "domain" }, { resolution: "keep" }];
  return tiles[choice]!;
}

/** One line of a rule list: its condition, the place it files to, and the rows it places. */
function RuleLineRow({ rules, count, condition, pile }: {
  rules: readonly RuleDTO[]; count: number | null;
  condition: (r: RuleDTO) => string; pile: (f: Folder | null) => string;
}) {
  const t = useTranslations("screening");
  const r = rules[0]!;
  return (
    <div className="sm-rule-line">
      <span className="cond">
        {t("ruleLine", { condition: condition(r), place: pile(r.destination) })}
        {rules.length > 1 ? <span className="twins" aria-label={t("ruleTwinsAria", { count: rules.length })}> ×{rules.length}</span> : null}
      </span>
      {count === null ? (
        <InfoNote className="n un" lead={t("ruleUncounted")} moreLabel={t("ruleUncountedMore")}>
          {t("ruleUncountedMore")}
        </InfoNote>
      ) : (
        <span className="n">{count}</span>
      )}
    </div>
  );
}

/**
 * THE RESOLVE STEP — the rules that disagree with the press, and two answers, the default chosen.
 * A radiogroup (↑/↓, Enter commits); Escape and Cancel go back to the list. The counts are the
 * forecast's, placed as the list will show them, so the tile and the sentence after agree.
 */
function ResolveStep({
  step, scope, place, domain, domainSenders, domainCount, condition, pile, unsubscribeSentence,
  onChoice, onCommit, onCancel,
}: {
  step: Extract<SheetStep, { kind: "resolve" }>;
  scope: ScreeningScope;
  place: string;
  domain: string;
  domainSenders: number;
  domainCount: number;
  condition: (r: RuleDTO) => string;
  pile: (f: Folder | null) => string;
  unsubscribeSentence: string | null;
  onChoice: (choice: 0 | 1) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("screening");
  const tilesRef = useRef<HTMLDivElement>(null);
  const f = step.forecast;
  const terms = f.groups.filter(isTerm);
  const inside = f.groups.filter((g) => g.cause === "own-rule-inside");
  const outranking = f.exception?.rule ?? f.groups.find((g) => g.cause === "domain-outranks")?.rule ?? null;
  const listed = step.cls === "term" ? terms : step.cls === "inside" ? inside : [];
  const keptRows = listed.reduce((n, g) => n + (g.rows?.length ?? 0), 0);
  const counted = listed.every((g) => g.rows !== null);
  const insideSenders = new Set(inside.map((g) => g.rule.match.trim().toLowerCase())).size;
  const all = (condition: string) => t("ruleLine", { condition, place });
  const wide = all(t("scopeDomain", { domain }));

  const title = step.cls === "term"
    ? t("resolveTitle", { place, rules: terms.length })
    : step.cls === "inside"
      ? t("resolveTitleDetail", { place, detail: t("ruleInside", { senders: insideSenders }) })
      : t("resolveDomainTitle", { place, domain, domainPlace: pile(outranking?.destination ?? null) });

  const keepTile = {
    title: t("resolveKeepTitle"), count: f.keep.landing.length,
    note: counted ? t("resolveKeepNote", { count: keptRows, rules: listed.length || 1 }) : t("resolveKeepNoteUncounted"),
  };
  const tiles = step.cls === "term"
    ? [{ title: all(t("ruleAll")), count: f.remove.landing.length, note: t("resolveAllNote", { rules: terms.length }) }, keepTile]
    : step.cls === "inside"
      ? [
          { title: t("resolveInsideKeepTitle"), count: f.keep.landing.length, note: null },
          { title: wide, count: f.remove.landing.length, note: t("resolveInsideAllNote", { rules: inside.length }) },
        ]
      : f.exception
        ? [
            { title: all(t("ruleOnlyThis")), count: f.keep.landing.length,
              note: t("resolveExceptNote", { domain, domainPlace: pile(outranking?.destination ?? null) }) },
            { title: wide, count: domainCount, note: t("resolveWholeNote", { senders: domainSenders }) },
          ]
        : [{ title: wide, count: domainCount, note: t("resolveWholeNote", { senders: domainSenders }) }, keepTile];

  useEffect(() => {
    tilesRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [step.choice]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); onChoice(step.choice === 0 ? 1 : 0); }
    else if (e.key === "Enter") { e.preventDefault(); onCommit(); }
  };

  return (
    <div className="sm-confirm sm-resolve">
      <p>{title}</p>
      <div className="sm-rules in-step">
        {step.cls === "domain" && outranking ? (
          <RuleLineRow rules={[outranking]} count={scope === "sender" ? f.keep.places.size : null} condition={condition} pile={pile} />
        ) : (
          listed.slice(0, 3).map((g) => (
            <RuleLineRow key={g.rule.id} rules={[g.rule]} count={g.rows?.length ?? null} condition={condition} pile={pile} />
          ))
        )}
      </div>
      <div className="sm-choices" role="radiogroup" aria-label={t("resolveChoiceAria")} ref={tilesRef} onKeyDown={onKey}>
        {tiles.map((tile, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={step.choice === i}
            tabIndex={step.choice === i ? 0 : -1}
            className={step.choice === i ? "sm-choice on" : "sm-choice"}
            onClick={() => onChoice(i as 0 | 1)}
          >
            <span className="head"><b>{tile.title}</b><span className="n">{t("scopeCountOne", { count: tile.count })}</span></span>
            {tile.note ? <small>{tile.note}</small> : null}
          </button>
        ))}
      </div>
      {unsubscribeSentence ? <p className="sm-resolve-unsub">{unsubscribeSentence}</p> : null}
      <span className="sm-confirm-row">
        <button type="button" className="go" onClick={onCommit}>
          {unsubscribeSentence ? t("unsubCommit") : t("resolveGo", { place })} <Kbd>↵</Kbd>
        </button>
        <button type="button" onClick={onCancel}>{t("cancel")} <Kbd>esc</Kbd></button>
      </span>
    </div>
  );
}
