"use client";

/**
 * CHANGING A SENDER'S SCREENING FROM ANYWHERE.
 *
 * The requirement, made twice: select a sender and change their screening type; click a mail
 * address anywhere it appears — the Ohbox included — and change that sender's screening from
 * there. Before this, screening could only be decided from the Screener, and only for mail still
 * waiting there. Everywhere else the sender's routing was a thing that had happened to you.
 *
 * ── WHAT THE WIRE WILL ACTUALLY DO, AND WHERE THAT ENDS ─────────────────────────────────
 *
 * `POST /screener/:id` carries the DESTINATION and resolves `:id` only against mail whose
 * desired folder is still `ohmail/Screener`. So:
 *
 *   · a sender still WAITING is decided through the endpoint, which files their held mail to
 *     the pressed destination and promotes a rule pointing at that same folder, in one
 *     transaction. Nothing is composed on top;
 *   · a sender whose mail has left the Screener, which is the Ohbox case, would 404. There is
 *     no un-screen endpoint and this slice does not invent one. Their mail is moved with
 *     `move` and the rule is written with `rule_create`.
 *
 * ── THE SENTENCE THIS FILE USED TO CARRY, AND WHY IT IS WORTH KEEPING ────────────────────
 *
 * It read: *"the remaining three destinations are composed on top with `move`"*, and named the
 * fix — *"`POST /screener/:id` would have to carry a `dest`"* — as a limitation to be stated
 * honestly in the toast rather than closed. The composition was worse than a limitation. It was
 * a RACE: `decide` reads its held rows outside its transaction and upserts `desired_folder`
 * inside it, so a `move` committing in that window was silently stamped back to the endpoint's
 * default. What that produced was `provenance:'promoted'` rules pointing at `INBOX` for senders
 * admitted with **Reads**, the mail behind them sitting in the Ohbox, and `ohmail/Reads` left
 * very nearly empty — under a toast that said *"Reads — filed. Future mail from … files there
 * automatically."* Both halves of that sentence were false. Documenting a limitation is only
 * honest while the thing documented is the limitation and not a coin toss.
 *
 * ── THE SCOPE ───────────────────────────────────────────────────────────────────────────
 *
 * `scope: "domain"` widens both halves of a decision together — the mail that moves, and the
 * `kind` of the rule. It was on the wire and in the mutation vocabulary from the start
 * (`EngineMutation.screener_decide.scope`, `http-adapter.ts`'s body) and NO surface had ever
 * set it, so the whole feature was one argument away and unreachable.
 *
 * ── A RULE FROM PAST THE GATE, AND IT IS NOW THE DEFAULT ─────────────────────────────────
 *
 * The requirement: creating a rule must also apply it to the mail ALREADY in the mailbox, not
 * only to what arrives next, and that has to be the default.
 *
 * This used to be unbuildable and the comment here said so. It was true of the vocabulary, not
 * of the server: `POST /rules` had been mounted the whole time with no caller, and the only
 * rule-creating verb the engine knew was `screener_decide`, whose effects are empty for a
 * representative outside `ohmail/Screener` — which `Engine.mutate` turns into a local rollback
 * with **nothing sent**, so no amount of server-side relaxation could have reached it. The verb
 * `rule_create` closes that, following `rule_delete`/`rule_update` exactly. The engine remains
 * the only wire: `app/api-client` is DENY'd from the desktop mirror this file is copied into
 * (`scripts/publish-desktop.mjs`), so a surface here cannot go around it.
 *
 * So the sheet now has THREE outcomes rather than two, and `ScreeningPlan.ruleState` names
 * which one happened. Making the rule is the DEFAULT (`makeRule`), and the move-only path
 * survives as the explicit opt-out.
 *
 * ── WHAT "APPLY TO ALL PREVIOUS" DOES, AND WHERE IT NOW HAPPENS ─────────────────────────
 *
 * This comment used to say the retroactive half was covered "for the mail this client has
 * synced" and not for the rest, and that a bounded server-side pass was owed. **The first half
 * was misleading and the second is now shipped.** The mirror is not a window: `/sync` replays
 * the whole `change_log` from seq 0 and `Engine.drain` loops until `hasMore` is false, so the
 * mirror holds every message in the account. The SET this planner computed was already right.
 *
 * What was wrong was the SHAPE. One `move` mutation per matching message is one
 * `POST /messages/:id/move` per message — thousands of requests from a browser tab, each taking
 * the account's own write lock, fired unawaited, and abandoned half-done if the
 * tab is closed. So the retroactive half now belongs to the server: `rule_create` carries
 * `applyRetro`, `RulesService` stamps `rules.retro_requested_at`, and the worker's
 * `ruleRetroPass` walks the backlog in bounded, resumable pages, writing desired-state the
 * reconciler turns into real IMAP moves. It inherits `sensitive-rescreen`'s rule that a message
 * the user has already acted on is not ours to move.
 *
 * The client still moves what the user can SEE — {@link RETRO_VISIBLE_MOVES} of it — because the
 * alternative is a click with no visible effect until a worker cycle, a reconcile and a drain
 * have all happened. Both writers write the same `desired_folder` with `lastSetBy: 'us'`, so the
 * second is a no-op and the pass's candidate query drops the row; this is NOT the double-move
 * the domain-scope comment further down refuses, because there is no second side effect and no
 * consent record to fork.
 *
 * The copy therefore still never says "every message", for two reasons that survive: the pass
 * re-evaluates through `evaluateRules` and a higher-priority deny rule can keep a message where
 * it is, and its cursor is a random UUID so a still-draining backlog can outrun it.
 *
 * This module is pure: it reads the mirror and returns mutations. `SenderMenu` renders it
 * and `AppShell` dispatches them, so the mapping below is testable without a DOM.
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
 * THE MAPPING THAT MUST NOT SLIP: which destinations ride the endpoint's `no`.
 *
 * `decision` is the CONSENT — admit this sender, or refuse them — and `dest` is the filing
 * address. Both travel now, and the server refuses a body where they disagree (400), so this
 * map is what keeps the sheet from writing one. It was once caught shipping "yes unless
 * screened", which meant "Mark spam" asked the server to file that sender into the Ohbox and
 * promoted a rule sending their future mail there.
 *
 * It is also what `unsubscribes` below is computed from, so a change here moves both the wire
 * body and the sentence the sheet shows before the click.
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
 * WHETHER "ALSO APPLY IT TO MY EXISTING MAIL" IS ON WHEN THE SHEET OPENS — **it is**.
 *
 * The requirement is about the DEFAULT: applying a rule to the messages already in the mailbox
 * as well as to the ones still to come. An opt-in would have changed nothing about managing a
 * mailbox. The server agrees — `RulesService.create` treats an
 * absent `applyRetro` as `true` — and the surface sends the value explicitly anyway, so what
 * ships is decided here, in one line, rather than by a field's absence.
 *
 * ── THE PREREQUISITE, CHECKED RATHER THAN ASSUMED ────────────────────────────────────────
 *
 * A default that creates rules is only safe behind a surface that can take them back:
 * otherwise it builds a mailbox the user cannot un-organize. That surface exists —
 * `app/views/RulesView.tsx` is imported and rendered by `SettingsView.tsx` with `onRevoke` and
 * `onRetarget`, wired in `AppShell`, and `test/rules-surface.test.ts` holds 20 tests over it.
 * So every rule this default writes is visible, retargetable and revocable at Settings → Rules
 * before it is written, which is the condition the row actually asks for.
 *
 * What revoking does NOT do is move mail back — `DELETE /rules/:id` touches the rules row and
 * the change log and nothing else. That is why the way back offered here is the count and the
 * opt-out BEFORE the click, and why the sheet must not imply a restore that does not exist.
 */
export const RETRO_DEFAULT_ON = true;

/**
 * How many messages the CLIENT still moves itself, newest first.
 *
 * Not a limit on what the user asked for — the server pass applies the rule to all of it. This
 * is only the optimistic half: the rows the user is looking at move at once instead of waiting
 * for a worker cycle, a reconcile and a `/sync` drain. Past what a screen can show, an extra
 * `POST /messages/:id/move` buys nothing a person can see and costs the account's write lock.
 *
 * It is also a bound on the pre-existing defect: this fan-out had NO cap at all, so a domain
 * scope on a big provider fired one request per message, thousands of them, from a browser.
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
 * Read a sender out of the mirror, starting from ANY of their messages.
 *
 * Every list in the product stamps `data-id` with a message id, and the Screener's row id
 * is its representative message id, so one lookup serves the Ohbox, Reads, Receipts, the
 * Screener, Tags and Search without any view having to know what a "sender" entity is.
 */
export function senderScreening(reader: EntityReader, messageId: string): SenderScreening | null {
  const seed = reader.get<EngineMessage>("message", messageId);
  if (!seed) return null;
  const key = senderKey(seed.from.address);
  const domain = domainOf(seed.from.address);

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
  return {
    key,
    address: seed.from.address,
    domain,
    name: seed.from.name,
    messages: sender.messages,
    current: sender.current,
    waiting: sender.waiting,
    representativeId: sender.representativeId,
    // With no domain there is nothing to widen to, so the domain subject IS the sender subject
    // and `SenderMenu` refuses to offer the switch. It is never a silently-empty second option.
    scopes: { sender, domain: domain === "" ? sender : subjectOf(theirs) },
    rules: rulesList(reader).filter((r) => r.enabled && ruleMatchesSender(r, seed.from.address)),
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
 * WHAT THIS DID TO THE RULE FOR THIS SUBJECT. Five states, because the sheet says a
 * different true sentence for each and a single boolean could only ever say two of them.
 *
 *  · `promoted`   — `POST /screener/:id` wrote it, server-side, as part of the decision.
 *  · `created`    — `POST /rules` wrote a new one (the default from past the gate).
 *  · `retargeted` — a rule for exactly this subject already existed, pointing somewhere else,
 *                   and was PATCHed rather than duplicated. See the ladder in the planner.
 *  · `already`    — one already files this subject's mail there. Nothing to write.
 *  · `none`       — the user opted out, and the move is all that happens.
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
   * Whether committing this ALSO hands mail to auto-unsubscribe, which the sheet must say
   * before the click and not after.
   *
   * True exactly when the DECIDE path runs AND the decision is the endpoint's `no` — never for
   * a rule this sheet writes itself, which is the honest negative and not a convenient one:
   * `RulesService.create` calls nothing, and the routing pass that consults rules on arrival
   * calls nothing either. A rule created from past the gate arms NOTHING today. `decide` calls
   * `unsubscribe.onScreenOut(ctx, <the mail it just re-routed>)` after its commit on the reject
   * branch, and the server wires that dependency in, so this is live in the deployed API rather
   * than latent. A plain `move` to Screened does NOT arm it — nothing calls
   * the drain (`sweepScreenedOut` has no production caller) — so this is false for a sender who
   * has already left the gate, which is the honest answer and not a convenient one.
   */
  unsubscribes: boolean;
}

/**
 * The mutations that put every message from `s` into `dest`, and the rule that makes the next
 * one follow.
 *
 * Order matters and is the correctness: the rule and the decide go first so each follow-up
 * `move` computes its optimistic effect against an overlay that already contains it (the
 * engine's overlay is last-write-wins per entity), which is the same ordering
 * `screener-state.ts` documents for the Screener's own path.
 *
 * `makeRule` DEFAULTS TO TRUE, because the DEFAULT is where the requirement lives; an opt-in
 * rule would have changed nothing about managing a mailbox. `false` is the explicit
 * non-default the sheet keeps reachable, and is also what the BULK path passes, because its confirm copy promises no
 * rule and forty senders is not a place to start making promises silently.
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
   * ── THE RULE LADDER, AND IT RUNS BEFORE THE MOVES ───────────────────────────────────────
   *
   * The rule mutation is dispatched FIRST for the same reason the decide is: the durable half
   * of the intent should land before the mail is shuffled, so a sequence interrupted halfway
   * leaves a rule with mail still on its way rather than moved mail with nothing remembering
   * why. `AppShell` fires them in parallel, so this is an ordering of intent, not a barrier.
   *
   *  1. A WAITING subject makes no `rule_create` at all — `decide` promotes one server-side and
   *     a second row here would be a duplicate the user never asked for.
   *  2. A rule for exactly this subject already pointing at the destination ⇒ nothing to write.
   *     Without this, a habit-click mints a fresh identical rule every time.
   *  3. One pointing SOMEWHERE ELSE is RETARGETED, never duplicated — and every one of them is,
   *     not just the first. Two `manual` rules with the same match, priority, effect and kind
   *     fall through `core/src/rules.ts#compareRules` to an arbitrary ID TIE-BREAK, so leaving
   *     the old one standing would make "future mail files there too" a coin toss. Retargeting
   *     all of them makes the sentence true whichever wins.
   *  4. Otherwise, write one.
   *
   * A covering rule of the OTHER kind is deliberately not consulted: a `domain` rule is not
   * retargeted by a click on one address, because a new `sender` rule outranks it anyway
   * (`KIND_RANK`: sender 0, domain 1) and rewriting the domain's destination would silently
   * re-file everyone else at that domain. `s.rules` is already filtered to exact matches.
   */
  const covering = makeRule && !promoted ? s.rules.filter((r) => r.kind === scope) : [];
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
    // ── THE DECIDE OWNS EVERY HELD MESSAGE IN SCOPE, AND NOW FILES IT WHERE ASKED ─────────
    //
    // The endpoint moves the WAITING mail and nothing else, and — since `dest` rides the
    // decision — it moves it to `wanted`. So every held message in scope is already handled
    // and must not be moved a second time. Under `scope: "domain"` that is the whole domain's
    // held mail, because `decide` re-routes what its scope covers
    // (`screener-service.ts#heldRowsForDomain`).
    //
    // THE CONDITION THAT USED TO GUARD THIS IS GONE, and its removal is the slice.
    // `WIRE_DECIDE_FOLDER[decision] === wanted` was true only for Ohbox and Screen-out; for
    // the other three it was false, which is what let the `move` fan-out below cover them —
    // the composition that lost the race. With the destination on the decide it would be
    // trivially true for all five, so it is not written.
    //
    // The tempting alternative — emit `move`s for the domain's OTHER held senders so the
    // overlay paints them at once, since `mutationEffects` only overlays ONE address's held
    // mail whatever `scope` says — stays wrong for its own reasons. The moves are fired in
    // parallel and not awaited ({@link dispatchScreeningChange}), so a `move` that lands FIRST
    // takes the message out of `ohmail/Screener` and `decide`'s held-only lookup then cannot
    // see it: filed with no rule and no consent record, which is the fork this composition
    // exists to avoid. And a message that reaches the destination through `move` instead of
    // `decide` has no learning signal behind it.
    //
    // So those rows lag by one `/sync` drain, visibly and briefly, and that is the accepted
    // cost. The toast already states the true count.
    for (const m of subject.messages) {
      if (m.folder === FOLDER_OF_VIEW.screener) movedByDecide.add(m.id);
    }
  }

  /**
   * ── THE FAN-OUT IS CAPPED, AND IT USED TO BE UNBOUNDED ────────────────────────────────────
   *
   * Every one of these becomes its own `POST /messages/:id/move`, and every one of those takes
   * the account's own write lock for its transaction. Uncapped, a domain
   * scope on a shared provider fired one request per message — thousands, from a browser tab,
   * fire-and-forget, serializing the account's whole write path and leaving the remainder
   * unmoved for ever if the tab was closed halfway.
   *
   * `messages` is already sorted newest-first, so the slice is the mail the user is looking at.
   * The REST is not dropped: when `applyRetro` is on, the server pass owns it and is resumable.
   * When it is off, the user asked for a move and not for a rule, and the cap is then a genuine
   * limit — which is why the toast for that case counts what it actually moved.
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
 * WHICH SENTENCE THE SHELL IS ALLOWED TO SAY, GIVEN WHAT THE SERVER ACTUALLY ANSWERED.
 *
 * It lives here and not in `AppShell` for the reason `RulesView` already gives: a shell that
 * has to remember to branch on three statuses is a shell that can ship two of them. The rules
 * surface's first cut fired its toast on click and printed *"Rule revoked. Your mail hasn't moved."* over a 403
 * on a live account — the fixtures adapter never refuses, so every test was green. This slice
 * makes a CLAIM ABOUT FUTURE MAIL, which is exactly the kind of claim a refusal falsifies.
 *
 * `queued` is not folded into success: the overlay stands, so the rule is correctly on screen,
 * but the server has not been told and "future mail files there too" is a claim about the
 * server. The MOVES are not awaited and are not re-reported — they are `move`s, the same verb
 * every list already uses, and each one rolls its own row back on screen if it fails.
 *
 * Every key takes the same three placeholders (`sender`, `place`, `count`), which is what lets
 * the caller interpolate one of them without a five-armed branch of its own.
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
     * it shipped. Widening the await to it would change a shipped behaviour this slice was not
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
 * DISPATCH THE PLAN AND ANSWER WITH THE SENTENCE THAT IS TRUE.
 *
 * This lives here rather than inline in `AppShell` for one reason: a shell is not testable and
 * this repository's recurring defect is precisely a correct module under an untested wiring.
 * `tag_assign` had a finished picker over an adapter that threw; the rules surface had a
 * three-outcome vocabulary under a toast that fired on click. Both were green. So the awaiting, the
 * fire-and-forget and the choice of sentence are ONE function with a `mutate` seam, and
 * `sender-screening.test.ts` drives it with an adapter that refuses.
 *
 * ── EXACTLY ONCE, AND ONLY THE RULE IS AWAITED ──────────────────────────────────────────
 *
 * `ruleMutations` is an identity-shared prefix of `mutations`, so the `includes` filter is what
 * keeps the rule from being dispatched twice — once awaited, once not, under two different
 * Idempotency-Keys, which on a route that does not honour the key means TWO rules. The moves
 * are deliberately not awaited: they are `move`s, the verb every list already uses, and each
 * one rolls its own row back on screen without a sentence needing to mention it.
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
