"use client";

/**
 * Rules — what the consent gate remembered, and the only way to take it back. `POST /screener/:id` writes a `rules`
 * row on every decision, and the five `/rules` endpoints were referenced by nothing: in a product whose thesis is a
 * gate that remembers your decisions, "and you can never see or undo them" is the part that compounds — a real
 * account had four invisible rules before this shipped.
 */

/**
 * A management surface, not a flat list: SEARCH (by sender or domain, client-side), FACET (by destination — the
 * frozen {@link RULE_DESTINATIONS}), act in bulk, and the list is windowed through {@link useListWindow} (History's
 * idiom). Bulk revoke acts over the FILTERED set — the filter IS the selection, so there is no checkbox column —
 * through the SAME per-rule `onRevoke` path a single revoke uses, behind the same two-click disclosure.
 */

/**
 * Three things it refuses to say. (1) No message count: `RuleDTO.stats` is declared and nothing has ever written one,
 * so a rule that filed three thousand messages would render "0" — the note says the count is not recorded, which is
 * true; the counts shown are the length of a client-side array, only where you consent to act on exactly that many.
 */

/**
 * (2) No promise about where future mail goes: a promoted YES also inserted a `contacts` row and the pipeline routes
 * on known senders independently of rules, so that sender stays known after the rule is gone, while a promoted NO
 * genuinely returns to the Screener — the row cannot tell which, so it claims only the half true of both: this rule
 * stops deciding. (3) No retroactive move, stated BEFORE the act: `RulesService.remove` never touches `folder_state`,
 * and revoking is two clicks with the second under that sentence — pluralised for bulk, never weakened. A pane of
 * `SettingsView`, its own file so a test imports THIS and a route promotion is one branch.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, ListGroupLabel, SettingsNote, SettingsSection, Switch, TextField, useToast, type ToastOptions } from "@ohmail/ui";
import { FOLDER_OF_VIEW, PROFILE_RULES_SENT_MAX, pressVerdict, tallyVerdicts } from "@ohmail/client-engine";
import type { Folder, PressAnswer, RuleDTO, WaitingOnOrganizerView } from "@ohmail/client-engine";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { usePileNames } from "../shell/decision-copy";
import { placeLabel } from "../shell/format";
import { RETRO_DEFAULT_ON, SCREENING_DESTS } from "../shell/sender-screening";
import { displayRuleMatch } from "../shell/idn";
import { useListWindow } from "../shell/list-window";
import { organizerRefusalOf, organizerRefusalSentence } from "../shell/organizer-refusal";
import { postureRefusal, type RulesPosture } from "../shell/rules-posture";
import { useFocusFollows } from "../shell/focus-follows";
import { actingRules, outrankOf, twinsDiffer, waitingByRow } from "./rules-standing";
import "./rules.css";

/**
 * The six canonical folders a rule may file into — the same set the server's rule validation
 * enforces, in the order the rail lists them. The facets' order; what Change OFFERS is the
 * sender sheet's five ({@link changePlaces}), so the two lists cannot drift apart.
 */
export const RULE_DESTINATIONS: readonly Folder[] = [
  "INBOX",
  "ohmail/News",
  "ohmail/Receipts",
  "ohmail/Screener",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * WHERE A CHANGE MAY SEND A RULE — the sender sheet's five places, in its order, the rule's current
 * one among them and marked. A destination outside the five (the Screener, a folder of the
 * mailbox's own) is listed first, marked, so the row being changed always names where it files.
 */
export function changePlaces(rule: RuleDTO): Array<{ folder: Folder; current: boolean }> {
  const here = canonicalDestination(rule.destination);
  const five = SCREENING_DESTS.map((d) => FOLDER_OF_VIEW[d]);
  const places = five.map((folder) => ({ folder, current: folder === here }));
  return places.some((p) => p.current) ? places : [{ folder: here as Folder, current: true }, ...places];
}

/**
 * The height a rule row occupies, in pixels — fixed by `.rules-item{height}` in rules.css (two
 * ellipsised lines and a fixed control cluster). The window's first-frame estimate; every drawn
 * row carries its `data-index` and is measured, like every other windowed list.
 */
const RULE_ROW_PX = 64;

/**
 * AT PHONE WIDTH THE LIST IS THE PAGE — `rules.css`'s phone query, which lifts the list's own
 * bound there. A bounded scroller below the pills showed one rule at 360 and did not hand the
 * thumb back to the page, so there the window reads the page's scroll instead.
 */
const RULES_PAGE_QUERY = "(max-width: 640px)";

const phoneWidth = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.(RULES_PAGE_QUERY).matches === true;

/** The nearest ancestor that scrolls, or `null`: the list's own box then stands in. */
function pageScrollerOf(from: HTMLElement | null): HTMLElement | null {
  for (let el = from; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return el;
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "4 Aug 2026" — explicit, and deliberately not `toLocaleDateString`.
 *
 * The rest of the client formats dates by hand for the same reason (`selectors.ts`
 * `messageDisplayTime`): a locale-dependent string renders differently under the test
 * runner's ICU than in the browser, so an assertion about it either passes for the wrong
 * reason or is written loosely enough to assert nothing. The YEAR is always present, unlike
 * the message row's stamp — a rule is a standing decision and "2 Aug" on one made last year
 * is the same ambiguity that stamp already fixed for six-day-old mail.
 */
export function ruleDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A destination and the rules that file into it — the buckets the facet chips are built from. */
export interface RuleGroup {
  destination: Folder;
  rules: RuleDTO[];
}

/**
 * Bucket rules by destination, canonical order first, any non-canonical destination the server
 * sent appended in first-seen order. Only non-empty buckets are returned — a facet chip for a
 * destination with no rules would filter to nothing. Order within a bucket is preserved (newest
 * first, as the caller supplies).
 */
export function groupByDestination(rules: readonly RuleDTO[]): RuleGroup[] {
  const byDest = new Map<Folder, RuleDTO[]>();
  for (const r of rules) {
    const list = byDest.get(r.destination);
    if (list) list.push(r);
    else byDest.set(r.destination, [r]);
  }
  const groups: RuleGroup[] = [];
  for (const d of RULE_DESTINATIONS) {
    const list = byDest.get(d);
    if (list && list.length) {
      groups.push({ destination: d, rules: list });
      byDest.delete(d);
    }
  }
  for (const [destination, list] of byDest) groups.push({ destination, rules: list });
  return groups;
}

/**
 * The rule's SECOND term, trimmed — or `""` when it carries none (mail 0050).
 *
 * One accessor rather than four inline `?? ""`s, because "does this rule have a subject term" is
 * asked by the row, the search, the confirm and the bulk copy, and a reading that drifts between
 * them is a rule the list describes differently depending on which control you touched. The
 * whitespace class is `core/src/rules.ts#SUBJECT_TERM_TRIM`'s, so this file agrees with the router
 * about which values mean "no term".
 */
export function subjectTermOf(rule: RuleDTO): string {
  return (rule.subjectContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

/** The rule's THIRD term (mail 0052), on `subjectTermOf`'s contract — `""` for none. */
export function bodyTermOf(rule: RuleDTO): string {
  return (rule.bodyContains ?? "").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

/**
 * The rules a search box and a destination facet leave standing. Search is a case-insensitive
 * substring over `rule.match` — the address or domain a person recognises — AND over the subject
 * term, because a subject rule is the one kind whose defining feature is not its address: somebody
 * hunting for "the NinjaFirewall rule" types the token, and before mail 0050 there was nothing else
 * to type. The origin and destination are still excluded: they are chrome, not what anybody searches
 * for. An empty or whitespace query matches everything, and `"all"` is every destination.
 */
export function filterRules(
  rules: readonly RuleDTO[],
  query: string,
  facet: Folder | "all",
): RuleDTO[] {
  const q = query.trim().toLowerCase();
  return rules.filter(
    (r) =>
      (facet === "all" || r.destination === facet) &&
      (q === "" ||
        r.match.toLowerCase().includes(q) ||
        // …and over the form the ROW SHOWS. On an internationalized domain the row reads
        // `müller.example` and the stored match is `xn--mller-kva.example`, so searching only the
        // stored one loses the rule to the very characters the reader can see (`shell/idn.ts`).
        displayRuleMatch(r.match).toLowerCase().includes(q) ||
        subjectTermOf(r).toLowerCase().includes(q) ||
        // The body term (mail 0052), for the subject term's reason: it is what defines the rule.
        bodyTermOf(r).toLowerCase().includes(q)),
  );
}

/**
 * WHO DECIDED EACH RULE, as the list draws it: a person's rules, then the ones the act on
 * suggestions wrote for them (`RuleDTO.byOhmail`), each group in the caller's order. A rule from
 * a server that sends no mark is a person's.
 */
export function splitByDecider(rules: readonly RuleDTO[]): { yours: RuleDTO[]; ohmail: RuleDTO[] } {
  const yours: RuleDTO[] = [];
  const ohmail: RuleDTO[] = [];
  for (const r of rules) (r.byOhmail === true ? ohmail : yours).push(r);
  return { yours, ohmail };
}

/**
 * Which action, if any, is open. One at a time — two open confirms is two questions. A single
 * revoke/retarget carries the rule it targets; the bulk revoke acts over the filtered set and so
 * names no rule.
 */
type OpenAction =
  | { mode: "revoke"; ruleId: string }
  | { mode: "retarget"; ruleId: string }
  | { mode: "bulk" }
  | null;

/**
 * WHAT HAPPENED, AS THE ENGINE REPORTS IT. `engine.mutate` resolves to a `MutationResult`,
 * which satisfies this structurally — the callbacks are `engine.mutate(...)` and nothing else.
 * The holder rides along because a rule verb on a mailbox somebody else organizes answers 202
 * and this pane has to name what it is waiting for.
 */
export type RuleOutcome = PressAnswer;

export interface RulesViewProps {
  /** Newest first — `rulesList(reader)`. */
  rules: RuleDTO[];
  /** `engine.mutate({ kind: "rule_delete", ruleId })`. */
  onRevoke: (ruleId: string) => Promise<RuleOutcome>;
  /** `engine.mutate({ kind: "rule_update", ruleId, destination, applyRetro })` — the answer always sent. */
  onRetarget: (ruleId: string, destination: Folder, applyRetro: boolean) => Promise<RuleOutcome>;
  /** `rule-past-mail.ts#rulePastMail` over the mirror: null where this device cannot count. */
  pastMail: (rule: RuleDTO, destination: Folder | null) => number | null;
  /** What a press can do here, from the roster (`rulesPostureOf`); absent reads as organizer. */
  posture?: RulesPosture;
  /** The rule requests waiting on the organizer (`engine.waitingOnOrganizer()`, `rule.*`). */
  waiting?: readonly WaitingOnOrganizerView[];
  /** A mailbox's address by id, for a request about a rule this page no longer lists. */
  mailboxLabel?: (mailboxId: string) => string | null;
}

export function RulesView({ rules: allRules, onRevoke, onRetarget, pastMail, posture, waiting = [], mailboxLabel }: RulesViewProps) {
  /* ONE ROW PER KEY, the twin the router runs; the rest are counted on it and go with it. */
  const { shown: rules, copies, others } = useMemo(() => actingRules(allRules), [allRules]);
  const { onRow, apart } = useMemo(() => waitingByRow(waiting, rules, allRules), [waiting, rules, allRules]);
  const t = useTranslations("rules");
  const piles = usePileNames();
  /** A place in the sheet's words where it has one ("Screened out"), else the place label. */
  const placeName = (folder: Folder): string => {
    const dest = SCREENING_DESTS.find((d) => FOLDER_OF_VIEW[d] === canonicalDestination(folder));
    return dest ? piles[dest] : placeLabel(folder);
  };
  /** The open Change's past-mail answer — the sheet's default, reset each time a Change opens. */
  const [retro, setRetro] = useState(RETRO_DEFAULT_ON);
  /* The list's name is the section's own heading, already on screen. */
  const tSettings = useTranslations("settings");
  const toast = useToast();
  /* The WHY of a reader's refusal is the shell's shared sentence, not a rules-only one. */
  const tWhy = useTranslations("ohbox");

  /**
   * WHAT A RULE SAYS, IN ONE LINE — and for a subject rule that is TWO terms, not one. `what.sender` renders "mail
   * from x@y.com". A rule carrying `subjectContains` says something strictly narrower, and rendering it with the same
   * string is the defect this exists to close: two rules for one address — the broad one and the `[NinjaFirewall]`
   * one — would appear as identical rows with identical Change and Revoke buttons, and revoking "the wrong one" would
   * be a coin toss a person could not even see they were making. The conjunction is spelled out rather than
   * abbreviated to a chip, because the term is the thing the reader has to check character by character: a rule that
   * is one letter off looks right and files nothing.
   */
  const whatOf = (rule: RuleDTO): string => {
    const base = t(`what.${rule.kind}`, { match: displayRuleMatch(rule.match) });
    const term = subjectTermOf(rule);
    const body = bodyTermOf(rule);
    // A rule may carry either term or both (mail 0052); every carried term is spelled out, because
    // an unnamed conjunct is a row indistinguishable from a broader rule — the defect above.
    if (term !== "" && body !== "") {
      return t("whatBoth", { base, term, body });
    }
    if (body !== "") return t("whatBody", { base, body });
    if (term === "") return base;
    return t("whatSubject", { base, term });
  };
  const [open, setOpen] = useState<OpenAction>(null);
  /**
   * A REFUSAL STAYS ON THE PANE until the next press — never only a toast, which is gone in
   * under three seconds and read as nothing said. `why` names the reason and the
   * way out where the refusal carries one.
   */
  const [refusal, setRefusal] = useState<{ lead: string; why: string | null } | null>(null);
  const whyOf = (err: Parameters<typeof organizerRefusalOf>[0]): string | null =>
    organizerRefusalSentence(organizerRefusalOf(err, { starting: posture?.mode === "starting" }), tWhy);
  /* A pane nothing here can act on says so BEFORE the press, and its controls are unavailable. */
  const lockedWhy = organizerRefusalSentence(postureRefusal(posture), tWhy);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<Folder | "all">("all");
  const scrollerRef = useRef<HTMLDivElement>(null);
  /**
   * The open single-rule confirm's element, brought on-screen when it opens. `block: "nearest"`
   * so a confirm that is already visible moves NOTHING — only one that opened below the fold of
   * the bounded `.rules-scroll` (or of the page) slides in, by the minimum. Optional-called
   * because jsdom mounts this component without implementing scrollIntoView.
   */
  const confirmRef = useRef<HTMLDivElement | null>(null);
  /* Escape closes an open confirm, from inside it or from the button that opened it, and focus
     goes back to that button (`focus-follows.ts`). Keyed, so a confirm opened under another row
     is its own. */
  const bulkRef = useRef<HTMLDivElement | null>(null);
  const closeConfirm = useCallback(() => setOpen(null), []);
  useFocusFollows(confirmRef, {
    active: open !== null && "ruleId" in open ? `${open.mode}:${open.ruleId}` : null,
    enter: false,
    onEscape: closeConfirm,
  });
  useFocusFollows(bulkRef, { active: open?.mode === "bulk", enter: false, onEscape: closeConfirm });
  useEffect(() => {
    if (open && open.mode !== "bulk") confirmRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  const groups = useMemo(() => groupByDestination(rules), [rules]);
  /**
   * If the selected facet's bucket emptied (its last rule was revoked), fall back to "all" rather
   * than showing an empty pane under a chip that no longer has a bucket. Computed, not stored, so
   * it self-heals on the next render without an effect.
   */
  const activeFacet =
    facet !== "all" && groups.some((g) => g.destination === facet) ? facet : "all";
  const filtered = useMemo(
    () => filterRules(rules, query, activeFacet),
    [rules, query, activeFacet],
  );

  /* The scroller the window reads: the list's own box, or at phone width the page's. Resolved
     before the window subscribes, and a width crossing the query re-subscribes it. */
  const [phone, setPhone] = useState(phoneWidth);
  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(RULES_PAGE_QUERY) : undefined;
    if (!mq) return;
    const on = (): void => setPhone(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  const pageRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    pageRef.current = phone
      ? pageScrollerOf(scrollerRef.current?.parentElement ?? null) ?? scrollerRef.current
      : null;
  }, [phone]);
  /* A person's rules, then the act's under their own label: one index space, the label in it. */
  const { yours, ohmail } = useMemo(() => splitByDecider(filtered), [filtered]);
  const labelAt = ohmail.length > 0 ? yours.length : -1;
  const win = useListWindow({
    scrollerRef: phone ? pageRef : scrollerRef,
    count: yours.length + (ohmail.length > 0 ? ohmail.length + 1 : 0), estimate: RULE_ROW_PX,
  });
  const yoursFrom = Math.min(win.start, yours.length);
  const yoursTo = Math.min(win.end, yours.length);
  const ohmailFrom = Math.max(0, Math.min(win.start - labelAt - 1, ohmail.length));
  const ohmailTo = Math.max(0, Math.min(win.end - labelAt - 1, ohmail.length));

  /**
   * THE TOAST WAITS FOR THE OUTCOME, AND IT LIVES HERE RATHER THAN IN THE SHELL. It fired immediately in the first
   * cut, so a server that answered `403` got *"Rule revoked. Your mail hasn't moved."* printed over the refusal — the
   * optimistic tombstone rolled back, so the rule REAPPEARED underneath a message saying it was gone. Only a refusal
   * surfaces this, and `FixturesAdapter` never refuses, so every test stayed green. `queued` is NOT folded into
   * success. The engine keeps a retryable failure on its offline queue with the overlay standing, so the row is
   * correctly gone from the screen — but the server has not been told yet, and "revoked" is a claim about the server.
   */
  const report = (res: RuleOutcome, ok: string, queued: string, failed: string, undo?: ToastOptions): void => {
    const v = pressVerdict(res);
    // A newer press for this rule replaced this one: it owns the sentence.
    if (v.kind === "silent") return;
    if (v.kind === "refused") { setRefusal({ lead: failed, why: whyOf(v.refusal) }); return; }
    if (v.kind === "queued") {
      /* THE TWO WAITS ARE DIFFERENT SENTENCES. `retry` is this browser's own queue, which the
         next connection drains. `organizer` is a request recorded for the install that organizes
         this mailbox — the rule is STILL FILING MAIL until that install's next pass, and saying
         "revoked" over it is telling somebody a rule is gone while it runs. */
      toast(v.wait === "retry" ? queued
        : v.holder ? t("toastRuleOrganizer", { name: v.holder })
        : t("toastRuleOrganizerUnknown"));
      return;
    }
    toast(ok, undo);
  };

  /**
   * A CHANGE SAYS WHAT IT DOES TO THE MAIL ALREADY FILED. The answer is always sent:
   * absent, the server re-arms the past mail on a retarget, which moved a screened-out sender's
   * mail into the Ohbox under "Mail already filed stays where it is". The count is read before the
   * press; Undo puts the rule back with the same answer, so the pass moves that mail back too.
   */
  const retarget = (rule: RuleDTO, folder: Folder, applyRetro: boolean): void => {
    setOpen(null);
    setRefusal(null);
    const from = canonicalDestination(rule.destination) as Folder;
    const place = placeName(folder);
    const moved = applyRetro ? pastMail(rule, folder) : null;
    const said = !applyRetro ? t("toastRetargeted", { place })
      : moved === null ? t("toastRetargetedRetroUncounted", { place })
        : moved === 0 ? t("toastRetargetedRetroNone", { place })
          : t("toastRetargetedRetro", { place, count: moved });
    const back = placeName(from);
    const undo: ToastOptions = {
      action: t("undo"),
      duration: 8000,
      onAction: () => {
        void onRetarget(rule.id, from, applyRetro).then((r) =>
          report(r, t(applyRetro ? "toastRetargetUndoneRetro" : "toastRetargetUndone", { place: back }),
            t("toastRetargetQueued"), t("toastRetargetFailed")));
      },
    };
    void onRetarget(rule.id, folder, applyRetro).then((r) =>
      report(r, said, t("toastRetargetQueued"), t("toastRetargetFailed"), undo));
  };

  /**
   * Bulk revoke fans the SAME per-rule mutation over the filtered set and then reports ONE toast
   * that is true of the whole batch. A batch is not confirmed unless every rule confirmed: a
   * single refusal makes it "revoked X of N, the rest are still in place", never a flat success,
   * because the rules that rolled back are exactly as present as before. Nothing refused and
   * something WAITING is its own sentence — those rules are still filing mail.
   */
  const runBulk = (ids: string[]): void => {
    setOpen(null);
    const total = ids.length;
    setRefusal(null);
    void Promise.all(ids.map((id) => onRevoke(id))).then((results) => {
      const vs = results.map(pressVerdict);
      const tally = tallyVerdicts(vs);
      const why = whyOf(tally.firstRefusal);
      const waiting = vs.filter((v) => v.kind === "queued" && v.wait === "organizer").length;
      if (tally.refused === 0 && tally.applied === total) toast(t("bulkToastRevoked", { count: total }));
      else if (tally.refused === 0 && waiting > 0) {
        toast(tally.holder ? t("toastRuleOrganizer", { name: tally.holder }) : t("toastRuleOrganizerUnknown"));
      }
      else if (tally.refused === 0) toast(t("bulkToastQueued"));
      else if (tally.applied > 0) setRefusal({ lead: t("bulkToastPartial", { ok: tally.applied, count: total }), why });
      else setRefusal({ lead: t("bulkToastFailed"), why });
    });
  };

  /** The holder's name, or the words for an unnamed one. */
  const holderOf = (w: WaitingOnOrganizerView): string => w.holder.name ?? t("theOrganizer");
  /** What a request said and where it stands, in one line — null for a row nothing waits on. */
  const waitingLine = (w: WaitingOnOrganizerView | undefined): string | null => {
    if (!w) return null;
    const holder = holderOf(w);
    if (w.state === "refused") {
      return w.refusedReason === "no_such_rule" ? t("refusedGone", { holder }) : t("refusedOther", { holder });
    }
    const date = ruleDate(w.decidedAt);
    const dest = (w.target as { destination?: string }).destination;
    const said = w.kind === "rule.delete" ? t("waitingRemoval", { holder, date })
      : dest ? t(w.kind === "rule.create" ? "waitingCreate" : "waitingChange", { holder, place: placeLabel(dest), date })
        : t("waitingRemoval", { holder, date });
    return w.slow ? `${said} ${t("waitingSlow", { holder })}` : said;
  };
  /** A request about a rule this page does not list: removed here, or not yet made there. */
  const apartLine = (w: WaitingOnOrganizerView): { what: string; line: string } => {
    const r = (w.target as { rule?: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null } }).rule;
    const what = r ? whatOf({ kind: r.kind, match: r.match, subjectContains: r.subjectContains, bodyContains: r.bodyContains } as RuleDTO) : t("theOrganizer");
    if (w.state !== "refused" && w.kind === "rule.delete") {
      return {
        what,
        line: t("waitingRemovedHere", {
          holder: holderOf(w), mailbox: (w.mailboxId ? mailboxLabel?.(w.mailboxId) : null) ?? t("theMailbox"), date: ruleDate(w.decidedAt),
        }),
      };
    }
    return { what, line: waitingLine(w) ?? "" };
  };
  /** Let an outranked address rule decide again: the same place, lifted at the write (`enrich`). */
  const lift = (rule: RuleDTO): void => {
    setRefusal(null);
    void onRetarget(rule.id, canonicalDestination(rule.destination) as Folder, false).then((r) =>
      report(r, t("toastLifted"), t("toastRetargetQueued"), t("toastRetargetFailed")));
  };
  const leftBehind = Math.max(0, allRules.length - PROFILE_RULES_SENT_MAX);
  const boundNote = leftBehind > 0
    ? <SettingsNote>{t("profileBound", { max: PROFILE_RULES_SENT_MAX, count: leftBehind })}</SettingsNote>
    : null;
  const waitingGroup = apart.length > 0 ? (
    <div className="rules-waiting" role="list" aria-label={t("waitingGroup")}>
      {/* NO `index`: this group stands outside the window's index space. At phone width the page is
          the window's scroller, and a label claiming slot 0 was measured as row 0 — the window
          re-measured for ever (React's update-depth error) and the pane did not render. */}
      <ListGroupLabel group="waiting">{t("waitingGroup")}</ListGroupLabel>
      {apart.map((w, i) => {
        const { what, line } = apartLine(w);
        return (
          <div key={w.requestId ?? `apart-${i}`} className="rules-item waiting" role="listitem" data-waiting-kind={w.kind}>
            <span className="body">
              <b className="what">{what}</b>
              <span className="meta">{line}</span>
            </span>
          </div>
        );
      })}
    </div>
  ) : null;

  if (rules.length === 0) {
    if (waitingGroup) {
      return (
        <SettingsSection className="rules-view">
          {waitingGroup}
          <SettingsNote>{t("noCount")}</SettingsNote>
        </SettingsSection>
      );
    }
    return (
      <SettingsSection className="rules-view">
        <p className="set-note-inline">{t("empty")}</p>
        <SettingsNote>{t("noCount")}</SettingsNote>
      </SettingsSection>
    );
  }

  const showSearch = rules.length >= 2;
  const showFacets = groups.length >= 2;
  const showBulk = filtered.length >= 2;

  /** One rule's row and its confirm. `index` is its slot; `size`/`position` place it in its group. */
  const ruleRow = (rule: RuleDTO, index: number, size: number, position: number) => {
    const what = whatOf(rule);
    const origin = rule.byOhmail === true ? t("origin.byOhmail") : t(`origin.${rule.provenance}`);
    const meta = rule.enabled
      ? t("meta", { origin, date: ruleDate(rule.createdAt) })
      : t("metaPaused", { origin, date: ruleDate(rule.createdAt) });
    const openHere = open !== null && "ruleId" in open && open.ruleId === rule.id;
    const waits = waitingLine(onRow.get(rule.id));
    const rank = outrankOf(rule, allRules);
    const twins = copies.get(rule.id) ?? 0;
    const behind = others.get(rule.id) ?? [];
    // Twins filing elsewhere, or paused where this row runs, are rules of their own: named, not counted.
    const twinNote = twins === 0 ? null : twinsDiffer(rule, behind)
      ? t("otherTwins", {
        count: behind.length,
        list: behind.map((o) => t(o.enabled ? "twinPlace" : "twinPaused", { place: placeLabel(o.destination) })).join("; "),
      })
      : t("copies", { count: twins });
    return (
      <Fragment key={rule.id}>
        <div
          className={`rules-item${openHere ? " editing" : ""}${waits || rank || twins > 0 ? " noted" : ""}`}
          data-rule-id={rule.id}
          data-index={index}
          role="listitem"
          aria-setsize={size}
          aria-posinset={position}
        >
          <span className="body">
            <b className="what">{what}</b>
            <span className="meta">
              {meta} · {t("filesInto", { place: placeLabel(rule.destination) })}
            </span>
            {rank ? (
              <span className="meta rules-rank" data-rank={rank.kind}>
                {t(rank.kind, { domain: displayRuleMatch(rank.domain), place: placeLabel(rank.place) })}
              </span>
            ) : null}
            {/* The way back sits under the sentence it answers, not beside Change and Revoke. */}
            {rank?.kind === "outranked" ? (
              <Button variant="ghost" className="rules-lift" disabled={lockedWhy !== null} onClick={() => lift(rule)}>
                {t("liftAction")}
              </Button>
            ) : null}
            {twinNote ? <span className="meta rules-copies">{twinNote}</span> : null}
            {waits ? <span className="meta rules-waits" role="status">{waits}</span> : null}
          </span>
          <span className="acts">
            <Button
              variant="ghost"
              disabled={lockedWhy !== null}
              aria-describedby={lockedWhy ? "rules-locked-why" : undefined}
              aria-expanded={openHere && open.mode === "retarget"}
              onClick={() => {
                setRetro(RETRO_DEFAULT_ON);
                setOpen(
                  open?.mode === "retarget" && open.ruleId === rule.id
                    ? null
                    : { mode: "retarget", ruleId: rule.id },
                );
              }}
            >
              {t("change")}
            </Button>
            <Button
              variant="ghost"
              disabled={lockedWhy !== null}
              aria-describedby={lockedWhy ? "rules-locked-why" : undefined}
              aria-expanded={openHere && open.mode === "revoke"}
              onClick={() =>
                setOpen(
                  open?.mode === "revoke" && open.ruleId === rule.id
                    ? null
                    : { mode: "revoke", ruleId: rule.id },
                )
              }
            >
              {t("revoke")}
            </Button>
          </span>
        </div>

        {openHere && open.mode === "revoke" ? (
          <div className="rules-confirm" ref={confirmRef}>
            <b className="what">{what}</b>
            <span>{t("revokeExplain")}</span>
            <span className="acts">
              <Button
                variant="primary"
                onClick={() => {
                  setOpen(null);
                  setRefusal(null);
                  void onRevoke(rule.id).then((r) =>
                    report(r, t("toastRevoked"), t("toastRevokeQueued"), t("toastRevokeFailed")),
                  );
                }}
              >
                {t("revokeConfirm")}
              </Button>
              <Button onClick={() => setOpen(null)}>{t("cancel")}</Button>
            </span>
          </div>
        ) : null}

        {openHere && open.mode === "retarget" ? (() => {
          const matched = pastMail(rule, null);
          return (
            <div className="rules-confirm" ref={confirmRef}>
              <b className="what">{what}</b>
              <span>{t(retro ? "retargetExplainRetro" : "retargetExplain")}</span>
              <span className="rules-retro">
                <span className="lab">
                  <b>{t("retroToggle")}</b>
                  <small>
                    {matched === null ? t("retroToggleUncounted") : t("retroToggleNote", { count: matched })}
                  </small>
                </span>
                <Switch checked={retro} onChange={setRetro} ariaLabel={t("retroToggle")} />
              </span>
              <span className="acts">
                {/* The sender sheet's places, the current one marked and not pressable:
                    the row names where the rule files, and the list must too. */}
                <span className="rules-places">
                  {changePlaces(rule).map(({ folder, current }) => (
                    <Button
                      key={folder}
                      aria-current={current ? "true" : undefined}
                      disabled={current}
                      className={current ? "current" : undefined}
                      onClick={() => retarget(rule, folder, retro)}
                    >
                      {placeName(folder)}
                    </Button>
                  ))}
                </span>
                <Button variant="ghost" onClick={() => setOpen(null)}>
                  {t("cancel")}
                </Button>
              </span>
            </div>
          );
        })() : null}
      </Fragment>
    );
  };

  return (
    <SettingsSection className="rules-view">
      <p className="set-note-inline">{t("intro")}</p>
      {lockedWhy ? <p id="rules-locked-why" className="set-note-inline rules-locked" role="note">{lockedWhy}</p> : null}
      {refusal ? (
        <p className="set-note-inline rules-refusal" role="alert">
          <b>{refusal.lead}</b>{refusal.why ? <> {refusal.why}</> : null}
        </p>
      ) : null}

      {waitingGroup}

      {showSearch || showFacets || showBulk ? (
        <div className="rules-toolbar">
          {showSearch ? (
            <label className="rules-search">
              <Icon name="search" />
              <TextField
                shape="line"
                type="search"
                value={query}
                placeholder={t("search")}
                aria-label={t("searchLabel")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(null);
                }}
              />
            </label>
          ) : null}

          {showFacets ? (
            <div className="rules-facets" role="group" aria-label={t("facetLabel")}>
              <button
                type="button"
                className={activeFacet === "all" ? "on" : undefined}
                aria-pressed={activeFacet === "all"}
                onClick={() => {
                  setFacet("all");
                  setOpen(null);
                }}
              >
                {t("facetAll")}
              </button>
              {groups.map((g) => (
                <button
                  key={g.destination}
                  type="button"
                  className={activeFacet === g.destination ? "on" : undefined}
                  aria-pressed={activeFacet === g.destination}
                  onClick={() => {
                    setFacet(g.destination);
                    setOpen(null);
                  }}
                >
                  {placeLabel(g.destination)}
                </button>
              ))}
            </div>
          ) : null}

          {showBulk ? (
            <Button
              variant="ghost"
              className="rules-bulk"
              disabled={lockedWhy !== null}
              aria-describedby={lockedWhy ? "rules-locked-why" : undefined}
              onClick={() => setOpen(open?.mode === "bulk" ? null : { mode: "bulk" })}
            >
              {t("bulkRevoke", { count: filtered.length })}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* THE BULK ACTION REGION. Only the bulk confirm renders up here: it is about the whole
          filtered set, so the head of that set is where its disclosure belongs. A SINGLE
          revoke/retarget confirm renders inside the list, at the row it targets — see the
          window's map below. Either way it is not an "are you sure?": it is the one
          moment at which "your mail does not move" can be read BEFORE it is true. Removing it
          would make the sentence something the product says AFTER the act. */}
      {open?.mode === "bulk" ? (
        <div className="rules-confirm" ref={bulkRef}>
          <span>{t("bulkRevokeExplain", { count: filtered.length })}</span>
          <span className="acts">
            <Button variant="primary" onClick={() => runBulk(filtered.map((r) => r.id))}>
              {t("bulkRevokeConfirm", { count: filtered.length })}
            </Button>
            <Button onClick={() => setOpen(null)}>{t("cancel")}</Button>
          </span>
        </div>
      ) : null}

      <div className="rules-scroll" ref={scrollerRef}>
        {filtered.length === 0 ? (
          <p className="rules-empty">{t("noMatch")}</p>
        ) : (
          <>
            {/* The rows above and below the window, as reserved height — empty elements rather
                than a margin, so the scroller's scroll height and scrollbar match every row
                mounted; `aria-hidden` because this is geometry. The open confirm is the one
                non-row child (SET-M4), rendered directly under its target row so the disclosure
                is read AT the rule it is about, and Cancel leaves the reader in place. It carries
                no slot, so the spacers leave its height out: the error is one confirm (~2 rows),
                inside the 8-row overscan; when the row scrolls out, the confirm unmounts and
                returns with it — `open` state unaffected. Each row states its group's true size and
                its place in it, because only the window's rows are mounted. */}
            <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
            {yoursTo > yoursFrom ? (
              <div className="rules-list" role="list" aria-label={tSettings("rules")}>
                {yours.slice(yoursFrom, yoursTo).map((rule, k) =>
                  ruleRow(rule, yoursFrom + k, yours.length, yoursFrom + k + 1))}
              </div>
            ) : null}
            {/* THE ACT'S RULES, under their own label in the same index space: the label is
                measured like a row, so the spacers stay true across the two groups. */}
            {labelAt >= win.start && labelAt < win.end ? (
              <ListGroupLabel group="by-ohmail" index={labelAt}>{t("groupByOhmail")}</ListGroupLabel>
            ) : null}
            {ohmailTo > ohmailFrom ? (
              <div className="rules-list" role="list" aria-label={t("groupByOhmail")}>
                {ohmail.slice(ohmailFrom, ohmailTo).map((rule, k) =>
                  ruleRow(rule, labelAt + 1 + ohmailFrom + k, ohmail.length, ohmailFrom + k + 1))}
              </div>
            ) : null}
            {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
          </>
        )}
      </div>

      {boundNote}
      <SettingsNote>{t("noCount")}</SettingsNote>
    </SettingsSection>
  );
}
