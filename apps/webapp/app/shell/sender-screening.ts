"use client";

/**
 * Changing a sender's screening from anywhere. `POST /screener/:id` carries the DESTINATION and
 * resolves only mail still held at `ohmail/Screener`: a waiting sender is decided through it (held
 * mail filed and a rule promoted in one transaction); a sender past the gate would 404, so their
 * mail moves with `move` and the rule is written with `rule_create` (the old composed `move`s raced
 * `decide` and produced promoted rules pointing at INBOX). `scope: "domain"` widens both halves.
 * Making the rule is the DEFAULT; move-only is the opt-out. "Apply to all previous" belongs to the
 * server (`applyRetro` → the worker's resumable `ruleRetroPass`); the client still moves what the
 * user can SEE. Pure: reads the mirror, returns mutations.
 */
import {
  FOLDER_OF_VIEW,
  rulesList,
  senderKey,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type MutationStatus,
  type RuleDTO,
} from "@ohmail/client-engine";
import type { DecisionDestination } from "@ohmail/ui";
import { ruleMatchesSender } from "./sender-audit";

/** The five places a sender's mail can be screened to — the DecisionBar's own vocabulary. */
export type ScreeningDest = DecisionDestination;

export const SCREENING_DESTS: ScreeningDest[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * The mapping that must not slip: which destinations ride the endpoint's
 * `no`. `decision` is the CONSENT — admit or refuse — and `dest` is the
 * filing address; both travel, and the server refuses a body where they
 * disagree (400), so this map is what keeps the sheet from writing one. It
 * was once caught shipping "yes unless screened", which made "Mark spam"
 * file that sender into the Ohbox and promote a rule sending future mail
 * there. `unsubscribes` below is computed from it, so a change here moves
 * both the wire body and the sentence the sheet shows before the click.
 */
export const DECISION_OF_DEST: Record<ScreeningDest, "yes" | "no"> = {
  ohbox: "yes",
  reads: "yes",
  receipts: "yes",
  screened: "no",
  spam: "no",
};

/**
 * WHOSE MAIL A CHOICE IS ABOUT.
 *
 * The case that forces it is `no-reply-kbdtwjmegmd_he…@x.com` — a per-send address from a
 * sender the reader experiences as one list, which nobody would ever rule on individually. `domain` widens both
 * halves of a decision at once: the mail that moves AND, when the sender is still waiting, the
 * `kind` of the rule the server promotes.
 */
export type ScreeningScope = "sender" | "domain";

/**
 * Whether "also apply it to my existing mail" is on when the sheet opens — it is. The requirement
 * is about the DEFAULT: an opt-in would have changed nothing about managing a mailbox. The server
 * agrees (absent `applyRetro` is `true`) and the surface sends the value explicitly anyway, so what
 * ships is decided here in one line. The prerequisite is checked, not assumed: a default that
 * creates rules is only safe behind a surface that can take them back — `RulesView` is rendered by
 * `SettingsView` with `onRevoke`/`onRetarget` (`test/rules-surface.test.ts`). Revoking does NOT
 * move mail back, which is why the way back offered here is the count and the opt-out BEFORE the
 * click.
 */
export const RETRO_DEFAULT_ON = true;

/**
 * How many messages the CLIENT still moves itself, newest first. Not a
 * limit on what the user asked for — the server pass applies the rule to
 * all of it. This is the optimistic half: the rows the user is looking at
 * move at once instead of waiting for a worker cycle, a reconcile and a
 * drain. Past what a screen can show, an extra `POST /messages/:id/move`
 * buys nothing visible and costs the account's write lock. Also a bound on
 * the pre-existing defect: this fan-out had no cap, so a domain scope on a
 * big provider fired thousands of requests from a browser.
 */
export const RETRO_VISIBLE_MOVES = 50;

/** One scope's worth of facts. The sheet renders whichever the user has chosen. */
export interface ScreeningSubject {
  /** Every message the mirror holds for this subject, across all folders. */
  messages: EngineMessage[];
  /** Where that mail sits, or null when it is spread across more than one view. */
  current: ScreeningDest | "screener" | null;
  /** Still waiting: the ONLY state `POST /screener/:id` will resolve. */
  waiting: boolean;
  /** The representative message id that endpoint takes (the newest held one). */
  representativeId: string | null;
  /** How many distinct addresses this subject covers — 1 for `sender`, N for `domain`. */
  senders: number;
}

export interface SenderScreening {
  /** The address, case-folded — the same key the selectors and the server group by. */
  key: string;
  address: string;
  /**
   * The part after the `@`, lower-cased, or `""` for an address that has none.
   *
   * Empty means the domain scope must not be OFFERED: `decide` refuses it with a 400, because
   * an empty `match` on a `kind:'domain'` row is compared against
   * `split_part(lower(from_address), '@', 2)` — also `""` for any other malformed address — so
   * one such rule would quietly rule on all of them.
   */
  domain: string;
  name: string | null;
  /** Every message the mirror holds from this sender, across all folders. */
  messages: EngineMessage[];
  /** Where their mail sits, or null when it is spread across more than one view. */
  current: ScreeningDest | "screener" | null;
  /** Still waiting: the ONLY state `POST /screener/:id` will resolve. */
  waiting: boolean;
  /** The representative message id that endpoint takes (the newest held one). */
  representativeId: string | null;
  /** The same four facts for each scope — `sender` mirrors the four fields above. */
  scopes: Record<ScreeningScope, ScreeningSubject>;
  /**
   * THE ENABLED RULES THE MIRROR ALREADY HOLDS FOR THIS SUBJECT.
   *
   * Read here rather than in the planner so the planner stays a pure function of its argument
   * and the sheet's preview cannot compute a different answer from the dispatch. Only rules
   * that would be THE SAME RULE the sheet is about to write — an exact `sender` match on the
   * address, or an exact `domain` match on the domain, by `sender-audit.ts#ruleMatchesSender`,
   * which is the client's copy of `core/src/rules.ts#matches`. Disabled rules are excluded:
   * a paused rule sorts nothing, so it is not a reason to withhold a working one.
   */
  rules: RuleDTO[];
}

const DEST_OF_FOLDER = new Map<Folder, ScreeningDest | "screener">([
  [FOLDER_OF_VIEW.ohbox, "ohbox"],
  [FOLDER_OF_VIEW.reads, "reads"],
  [FOLDER_OF_VIEW.receipts, "receipts"],
  [FOLDER_OF_VIEW.screened, "screened"],
  [FOLDER_OF_VIEW.spam, "spam"],
  [FOLDER_OF_VIEW.screener, "screener"],
]);

const byDateDesc = (a: EngineMessage, b: EngineMessage) =>
  String(b.date ?? "").localeCompare(String(a.date ?? ""));

/**
 * Read a sender out of the mirror, starting from any of their messages. Every list stamps `data-id`
 * with a message id, and the Screener's row id is its representative message id, so one lookup
 * serves every view. The address override (contact chips): a recipient chip opens Screener settings
 * for THE CHIP'S address — a To/Cc person, not the sender — and `address` is how that reaches this
 * one lookup. The seed message still anchors everything and supplies the display name; the SUBJECT
 * of every fact becomes the override. Absent, the shipped behaviour. A recipient with no mail in
 * the mirror is a real subject: zero messages shown, and the rule still decides their future mail.
 */
export function senderScreening(
  reader: EntityReader,
  messageId: string,
  address?: string,
): SenderScreening | null {
  const seed = reader.get<EngineMessage>("message", messageId);
  if (!seed) return null;
  const subjectAddress = address ?? seed.from.address;
  const key = senderKey(subjectAddress);
  const domain = domainOf(subjectAddress);

  // ONE pass over the mirror for both scopes. Two `.filter()` calls would walk every message in
  // the account twice on a click, and the sheet reads this on every render.
  const mine: EngineMessage[] = [];
  const theirs: EngineMessage[] = [];
  for (const m of reader.list<EngineMessage>("message")) {
    const k = senderKey(m.from.address);
    if (k === key) mine.push(m);
    // `domain !== ""` guards the malformed-address case: without it every address with no `@`
    // would be grouped with every other one under the empty domain.
    if (domain !== "" && domainOf(m.from.address) === domain) theirs.push(m);
  }
  mine.sort(byDateDesc);
  theirs.sort(byDateDesc);

  const sender = subjectOf(mine);
  // The chip's display name, from the seed message's own entries: the sender's when the
  // override IS the sender (or there is none), else whatever the To/Cc entry wrote — the same
  // spelling the chip's face wore. Null for an address the seed does not carry.
  const name =
    senderKey(seed.from.address) === key
      ? seed.from.name
      : [...seed.to, ...seed.cc].find((r) => senderKey(r.address) === key)?.name ?? null;
  return {
    key,
    address: subjectAddress,
    domain,
    name,
    messages: sender.messages,
    current: sender.current,
    waiting: sender.waiting,
    representativeId: sender.representativeId,
    // With no domain there is nothing to widen to, so the domain subject IS the sender subject
    // and `SenderMenu` refuses to offer the switch. It is never a silently-empty second option.
    scopes: { sender, domain: domain === "" ? sender : subjectOf(theirs) },
    rules: rulesList(reader).filter((r) => r.enabled && ruleMatchesSender(r, subjectAddress)),
  };
}

/** The `match` a rule at this scope carries — normalized ONCE, for the overlay and the wire. */
export function ruleMatchOf(s: SenderScreening, scope: ScreeningScope): string {
  return scope === "domain" ? s.domain : s.address.trim().toLowerCase();
}

/** The part after the `@`, lower-cased — the server's `domainOf`, on the client. */
export function domainOf(address: string): string {
  const at = address.indexOf("@");
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/** The four facts the sheet renders, plus the sender count, for one already-sorted message set. */
function subjectOf(messages: EngineMessage[]): ScreeningSubject {
  const places = new Set(messages.map((m) => DEST_OF_FOLDER.get(m.folder)).filter(Boolean));
  const held = messages.filter((m) => m.folder === FOLDER_OF_VIEW.screener);
  return {
    messages,
    current: places.size === 1 ? ([...places][0] as ScreeningDest | "screener") : null,
    waiting: held.length > 0,
    // The newest HELD message, because `POST /screener/:id` resolves `:id` against held mail
    // only. Under domain scope that may belong to a different address than the one clicked —
    // which is correct: the server reads the representative's DOMAIN and rules on that.
    representativeId: held[0]?.id ?? null,
    senders: new Set(messages.map((m) => senderKey(m.from.address))).size,
  };
}

/**
 * What this did to the rule for this subject. Five states, because the
 * sheet says a different true sentence for each:
 *  · `promoted`   — `POST /screener/:id` wrote it as part of the decision.
 *  · `created`    — `POST /rules` wrote a new one (the past-the-gate default).
 *  · `retargeted` — a rule for exactly this subject existed, pointing
 *                   somewhere else, and was PATCHed rather than duplicated.
 *  · `already`    — one already files this subject's mail there.
 *  · `none`       — the user opted out; the move is all that happens.
 */
export type ScreeningRuleState = "promoted" | "created" | "retargeted" | "already" | "none";

export interface ScreeningPlan {
  /** What goes on the wire, in dispatch order. Empty means nothing to do. */
  mutations: EngineMutation[];
  /**
   * The prefix of {@link ScreeningPlan.mutations} that writes the rule — the SAME objects, so
   * the two cannot disagree about what was dispatched. Empty for `promoted`, `already` and
   * `none`. The caller awaits exactly these to decide what to claim; see {@link screeningToast}.
   */
  ruleMutations: EngineMutation[];
  /** Which of the five things above happened. */
  ruleState: ScreeningRuleState;
  /**
   * Whether a rule will be in force for this subject afterwards — true for every state except
   * `none`, INCLUDING `already`, because the question the copy asks is "will future mail
   * follow?" and not "did this write a row?".
   */
  rule: boolean;
  /**
   * The subject of the rule that will be in force — `domain` widens it to everyone at the
   * domain. Non-null whenever {@link ScreeningPlan.rule} is, `already` included, because the
   * question it answers is whose future mail follows and not which row was written.
   */
  ruleScope: ScreeningScope | null;
  /**
   * Messages the CLIENT moves itself — capped at {@link RETRO_VISIBLE_MOVES}.
   *
   * This is no longer the number to put in front of a user, and the toast no longer does: it is
   * the optimistic half only. {@link ScreeningPlan.matched} is the honest one.
   */
  moved: number;
  /**
   * How much of this subject's mail is OUT OF PLACE and therefore in scope for the rule.
   *
   * The number the sheet shows before the click. It is a statement about MATCHING MAIL and never
   * a promise of how much will move: the server pass re-evaluates each message through
   * `evaluateRules`, so a higher-priority deny rule keeps its mail where it is.
   */
  matched: number;
  /**
   * Whether the rule this writes will ALSO be applied to mail already on the server.
   *
   * False for every plan that writes no rule, and for the explicit opt-out. Never true for
   * `promoted`: a waiting sender's mail is re-routed by `decide` inside the decision itself, so
   * a retroactive pass over it would be a second mover for mail already handled.
   */
  retro: boolean;
  /** Distinct addresses whose mail this touches — the number the domain copy states. */
  senders: number;
  /**
   * Whether committing this takes the path that hands mail to auto-unsubscribe — which the sheet
   * must say before the click. A fact about the CODE, not the account: the account switch and the
   * standalone case are the caller's second condition (`autoUnsubscribeDiscloses`); this is pure
   * over a `SenderScreening`. True exactly when the DECIDE path runs AND the decision is the
   * endpoint's `no` — never for a rule this sheet writes itself (`RulesService.create` calls
   * nothing, and the routing pass calls nothing: a past-the-gate rule arms NOTHING today), and a
   * plain `move` to Screened does not arm it either (`sweepScreenedOut` has no production caller).
   * The honest negative.
   */
  unsubscribes: boolean;
}

/**
 * The mutations that put every message from `s` into `dest`, and the rule that makes the next one
 * follow. Order matters and is the correctness: the rule and the decide go first so each follow-up
 * `move` computes its optimistic effect against an overlay that already contains it (the overlay is
 * last-write-wins per entity) — the same ordering `screener-state.ts` documents. `makeRule`
 * defaults TRUE, because the default is where the requirement lives; `false` is the explicit
 * non-default the sheet keeps reachable, and what the BULK path passes — its confirm copy promises
 * no rule.
 */
export function planScreeningChange(
  s: SenderScreening,
  dest: ScreeningDest,
  scope: ScreeningScope = "sender",
  makeRule = true,
  applyRetro = RETRO_DEFAULT_ON,
): ScreeningPlan {
  const wanted = FOLDER_OF_VIEW[dest];
  const subject = s.scopes[scope];
  const mutations: EngineMutation[] = [];
  const movedByDecide = new Set<string>();
  const promoted = subject.waiting && subject.representativeId != null;

  /**
   * The rule ladder, and it runs before the moves — the durable half lands first, so an interrupted sequence leaves a
   * rule with mail on its way rather than moved mail with nothing remembering why. 1. A WAITING subject makes no
   * `rule_create` — `decide` promotes one server-side. 2. A rule already pointing at the destination ⇒ nothing to
   * write. 3. One pointing somewhere else is RETARGETED — every one: identical `manual` rules fall to an ID tie-break
   * in `compareRules`, so leaving the old one makes "future mail files there too" a coin toss. 4. Otherwise, write
   * one. A covering rule of the OTHER kind is not consulted (a new `sender` rule outranks a `domain` one). A
   * subject-term rule (mail 0050) is never retargeted: it is one SLICE, deliberately built — it outranks the new
   * broad rule for its slice, and the broad rule takes the rest.
   */
  const covering = makeRule && !promoted
    // Neither term may be present (mail 0050/0051): a subject- or body-narrowed rule is the rule
    // for one SLICE of the sender's mail, and retargeting it from a whole-sender click would
    // destroy the split the user deliberately built — the note above, for both terms.
    ? s.rules.filter((r) => r.kind === scope
        && (r.subjectContains ?? "").trim() === ""
        && (r.bodyContains ?? "").trim() === "")
    : [];
  const ruleMutations: EngineMutation[] = [];
  let ruleState: ScreeningRuleState = "none";

  if (promoted) {
    ruleState = "promoted";
  } else if (makeRule) {
    if (covering.some((r) => r.destination === wanted)) {
      ruleState = "already";
    } else if (covering.length > 0) {
      ruleState = "retargeted";
      for (const r of covering) ruleMutations.push({ kind: "rule_update", ruleId: r.id, destination: wanted });
    } else {
      ruleState = "created";
      ruleMutations.push({
        kind: "rule_create",
        // THE RULE'S SUBJECT AND THE MAIL THAT MOVES COME FROM THE SAME `scope`, and that is
        // the whole guard. `decide` was once caught computing the mail to move BY ADDRESS
        // regardless of scope, so a domain rule moved one sender's mail and stranded the rest
        // behind a gate whose own rule already let them through. Here `match` is derived from
        // `scope` and the moves below are taken from `subject` — which IS `s.scopes[scope]` —
        // so the two cannot be given different subjects without changing both lines.
        ruleKind: scope,
        match: ruleMatchOf(s, scope),
        destination: wanted,
        // The retroactive half, and it is the DEFAULT. The server stamps the request and
        // the worker walks the backlog; nothing about it happens in this process.
        applyRetro,
      });
    }
  }
  mutations.push(...ruleMutations);

  if (subject.waiting && subject.representativeId) {
    const decision = DECISION_OF_DEST[dest];
    mutations.push({
      kind: "screener_decide",
      senderId: subject.representativeId,
      decision,
      scope,
      // ── THE BUTTON THE USER PRESSED, AND IT USED TO BE THE LITERAL `"ohbox"` ─────────────
      //
      // This read `...(decision === "yes" ? { dest: "ohbox" as const } : {})` — the sheet's
      // five destinations collapsed to one on the way to the wire, on the ground that the
      // endpoint could not express the others anyway and the `move`s below would finish the
      // job. They did not: `decide` reads its held rows outside its transaction and writes
      // `desired_folder` inside it, so a `move` landing in that window was stamped back.
      // Production carried four `promoted → INBOX` rules for senders admitted with **Reads**.
      dest,
    });
    // The decide owns every held message in scope, and now files it where
    // asked: since `dest` rides the decision, every held message in scope — under `scope:
    // "domain"`, the whole domain's held mail — is handled and must not be moved a second time. The
    // old guard (`WIRE_DECIDE_FOLDER[decision] === wanted`) is gone: with `dest` on the decide it
    // would be trivially true for all five. The tempting alternative — emit `move`s for the
    // domain's other held senders so the overlay paints at once — stays wrong: the moves are
    // unawaited, and one landing first takes the message out of `ohmail/Screener` so `decide`
    // cannot see it — filed with no rule and no consent record. Those rows lag one `/sync` drain,
    // visibly and briefly; the toast states the true
    // count.
    for (const m of subject.messages) {
      if (m.folder === FOLDER_OF_VIEW.screener) movedByDecide.add(m.id);
    }
  }

  /**
   * The fan-out is capped, and it used to be unbounded. Every entry becomes its own `POST
   * /messages/:id/move`, each taking the account's write lock: uncapped, a domain scope on a shared
   * provider fired thousands of fire-and-forget requests from a browser tab, serializing the
   * account's write path and abandoning the remainder if the tab closed. `messages` is sorted
   * newest-first, so the slice is the mail the user is looking at. The rest is not dropped: with
   * `applyRetro` on, the server pass owns it and is resumable; with it off, the user asked for a
   * move and the cap is a genuine limit — the toast counts what it actually moved.
   */
  const outOfPlace = subject.messages.filter((m) => m.folder !== wanted && !movedByDecide.has(m.id));
  const toMove = outOfPlace.slice(0, RETRO_VISIBLE_MOVES);
  for (const m of toMove) mutations.push({ kind: "move", messageId: m.id, folder: wanted });

  const retro = applyRetro && (ruleState === "created" || ruleState === "retargeted");
  return {
    mutations,
    ruleMutations,
    ruleState,
    rule: ruleState !== "none",
    ruleScope: ruleState !== "none" ? scope : null,
    moved: toMove.length + movedByDecide.size,
    // What the sheet states before the click: how much of this subject's mail is out of place.
    // `movedByDecide` is included because the decide relocates it too.
    matched: outOfPlace.length + movedByDecide.size,
    senders: subject.senders,
    retro,
    unsubscribes: promoted && DECISION_OF_DEST[dest] === "no",
  };
}

/**
 * Which sentence the shell is allowed to say, given what the server actually answered. Here and not
 * in `AppShell` for `RulesView`'s reason: a shell that must remember to branch on three statuses
 * can ship two — the rules surface's first cut printed "Rule revoked" over a 403 on a live account,
 * green against fixtures that never refuse. This slice makes a claim about FUTURE MAIL, exactly the
 * kind a refusal falsifies. `queued` is not folded into success: the overlay stands, but "future
 * mail files there too" is a claim about the server. The moves are not awaited or re-reported —
 * each rolls its own row back on failure. Every key takes the same three placeholders (`sender`,
 * `place`, `count`).
 */
export type ScreeningToastKey =
  | "toastRuled" | "toastRetargeted" | "toastAlreadyRuled"
  | "toastRuleQueued" | "toastRuleFailed" | "toastMoved";

export function screeningToast(
  plan: ScreeningPlan,
  ruleStatus: MutationStatus | null,
): ScreeningToastKey {
  switch (plan.ruleState) {
    case "none":
      return "toastMoved";
    case "already":
      return "toastAlreadyRuled";
    /**
     * THE DECIDE PATH IS NOT AWAITED AND KEEPS THE SENTENCE IT SHIPPED WITH. Its rule is
     * written by the server inside the decision's own transaction — there is no separate
     * request whose outcome could differ from the decision's — and that path was verified when
     * it shipped. Widening the await to it would change a shipped behaviour this change was not
     * asked to touch.
     */
    case "promoted":
      return "toastRuled";
    default:
      if (ruleStatus === "rolled_back") return "toastRuleFailed";
      if (ruleStatus === "queued") return "toastRuleQueued";
      return plan.ruleState === "retargeted" ? "toastRetargeted" : "toastRuled";
  }
}

/**
 * The WORST of several outcomes, because a plan can retarget more than one rule and a claim is
 * only as true as its weakest half. Ordered rolled_back < queued < confirmed: one refusal makes
 * the whole sentence false, and one queued mutation makes it not-yet-true.
 */
export function worstStatus(results: readonly { status: MutationStatus }[]): MutationStatus | null {
  if (results.length === 0) return null;
  if (results.some((r) => r.status === "rolled_back")) return "rolled_back";
  if (results.some((r) => r.status === "queued")) return "queued";
  return "confirmed";
}

/**
 * Dispatch the plan and answer with the sentence that is true. Here rather than inline in `AppShell`
 * because a shell is not testable, and this repository's recurring defect is a correct module under an
 * untested wiring (`tag_assign`'s finished picker over a throwing adapter; the rules surface's toast on
 * click) — so the awaiting, the fire-and-forget and the choice of sentence are ONE function with a
 * `mutate` seam, driven by `test/sender-screening.test.ts` with a refusing adapter. Exactly once, and
 * only the rule is awaited: `ruleMutations` is an identity-shared prefix of `mutations`, and the
 * `includes` filter keeps the rule from being dispatched twice under two Idempotency-Keys — on a route
 * that does not honour the key, two rules. The moves roll their own rows back.
 */
export async function dispatchScreeningChange(
  plan: ScreeningPlan,
  mutate: (m: EngineMutation) => Promise<{ status: MutationStatus }>,
): Promise<ScreeningToastKey> {
  const rules = plan.ruleMutations.map((m) => mutate(m));
  for (const m of plan.mutations) {
    if (!plan.ruleMutations.includes(m)) void mutate(m);
  }
  return screeningToast(plan, worstStatus(await Promise.all(rules)));
}

/**
 * The rules that hold a sender's mail at `folder` — the rows a release must rewrite. The consent cutline presents a
 * decided sender's mail at the RULE'S destination, so a sender with an enabled rule pointing at `ohmail/Quarantine`
 * has INBOX and Screener mail LISTED in Spam while it physically sits elsewhere: a release of bare `move`s either
 * rolls back locally or is re-presented by the rule (measured live, 2026-08-19 — every "Not spam → Ohbox" press
 * answered the refusal toast). A NEW allow rule beside the old cannot fix it: `compareRules` ranks deny over allow at
 * equal priority, so only retargeting or deleting the holding rule makes the surfaces agree. Term-free only (the
 * ladder's doctrine): a subject- or body-narrowed rule is one SLICE, deliberately built. Both kinds included: a
 * domain-scoped spam decision writes a `domain` deny rule, and its reversal must reach the same row.
 */
export function holdingRules(reader: EntityReader, address: string, folder: Folder): RuleDTO[] {
  return rulesList(reader).filter((r) =>
    r.enabled
    && r.destination === folder
    && (r.subjectContains ?? "").trim() === ""
    && (r.bodyContains ?? "").trim() === ""
    && ruleMatchesSender(r, address));
}
