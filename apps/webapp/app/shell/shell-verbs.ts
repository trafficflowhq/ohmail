"use client";

/**
 * SCREENING, TAGS, AND THE MESSAGE AND BULK VERBS — every press that writes a mailbox.
 *
 * One vocabulary behind four doors: a row's action bar, a stream card, a selection, and the
 * sender and subject sheets. ZERO effects move with it, so where the hook is called is decided
 * by what it reads and nothing else — below the composer, whose Reply, Forward and drafter this
 * dispatches. `fileThroughRouting` and the bulk-move split are the routing window's press half;
 * `UNDO_CLASS` is read from the engine's table, never restated. Lifted out of `AppShell.tsx`
 * unchanged (ARCH-022).
 */
import { useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { useTranslations } from "next-intl";
import {
  FOLDER_OF_VIEW,
  UNDO_CLASS,
  inverseMutations,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type OhmailEngine,
  type OhmailView,
  type TagDTO,
} from "@ohmail/client-engine";
import { type ToastFn } from "@ohmail/ui";
import type { ActedMarker } from "./after-verb";
import { replyAllRecipients } from "./compose-from";
import type { ConsentState } from "./consent-state";
import { dayStamp, PLACE_LABEL, resurfaceLabel, tomorrowAt } from "./format";
import { displayAddress, displayDomain } from "./idn";
import { readerMoveRefusal } from "./mail-state";
import type { BulkAction, MessageAction } from "./MessagePane";
import { attributeMessages } from "./sender-audit";
import { senderHitOf } from "./sender-hit";
import {
  RETRO_DEFAULT_ON,
  dispatchScreeningChange,
  planScreeningChange,
  screeningToast,
  senderScreening,
  splitRoutingPlan,
  worstStatus,
  type ScreeningDest,
  type ScreeningPlan,
  type ScreeningScope,
} from "./sender-screening";
import type { ShellCompose } from "./shell-compose";
import type { ShellDispatch } from "./shell-dispatch";
import type { ShellOpenState } from "./shell-open-state";
import { useStableCallback } from "./stable-callback";
import { planSubjectRule, subjectRuleContext, subjectRuleToast, type TermField } from "./subject-rule";
import { placePicker } from "./TagPicker";

/** `read`, answering `row` for its own id where `read` holds nothing — the pressed row as a seed. */
function withRow(read: EntityReader, row: EngineMessage): EntityReader {
  return {
    get: <T,>(type: string, id: string) => read.get<T>(type, id)
      ?? (type === "message" && id === row.id ? (row as unknown as T) : undefined),
    list: (type) => read.list(type),
    entries: (type) => read.entries(type),
    version: () => read.version(),
    stampOf: (type) => read.stampOf(type),
    stampExcept: (ignore) => read.stampExcept(ignore),
  };
}

export interface ShellVerbsInput {
  engine: OhmailEngine;
  /** The mirror as it is — `engine.read()` from the render, never re-read here. */
  reader: EntityReader;
  t: ReturnType<typeof useTranslations>;
  toast: ToastFn;
  /** Only the resurface hour: the horizon-less verbs mint tomorrow at the account's own time. */
  consent: Pick<ConsentState, "resurfaceTime">;
  /** The shell's clock — `DEMO_NOW` on the demo, so a dated sentence is deterministic. */
  nowAt: () => Date;
  /** The mirror's tags, for the name a tag verb says (`shell-derivations.ts`). */
  tags: TagDTO[];
  /** The account's own addresses — the reply-all gate asks them. */
  ownAddresses: string[];
  fileAndRefresh: ShellDispatch["fileAndRefresh"];
  toastWithUndo: ShellDispatch["toastWithUndo"];
  mutateAndReport: ShellDispatch["mutateAndReport"];
  mutateSetAndReport: ShellDispatch["mutateSetAndReport"];
  mailboxesOf: ShellDispatch["mailboxesOf"];
  refusalCopy: ShellDispatch["refusalCopy"];
  rosterRef: ShellDispatch["rosterRef"];
  /** The routing undo window — held, undone and asked for its subject; never redefined here. */
  routing: ShellDispatch["routing"];
  deleting: ShellDispatch["deleting"];
  restoring: ShellDispatch["restoring"];
  markSeen: ShellOpenState["markSeen"];
  /** The open reader's id: a delete or restore closes the sheet only over ITS own message. */
  readerFor: ShellOpenState["readerFor"];
  setReaderFor: ShellOpenState["setReaderFor"];
  setPicker: ShellOpenState["setPicker"];
  setPickerIds: ShellOpenState["setPickerIds"];
  setSenderMenu: ShellOpenState["setSenderMenu"];
  setSenderAudit: ShellOpenState["setSenderAudit"];
  setSubjectRule: ShellOpenState["setSubjectRule"];
  /** The inline editor's doors (`shell-compose.ts`) — Reply, Reply all and Forward. */
  toggleReply: ShellCompose["toggleReply"];
  openForward: ShellCompose["openForward"];
  openReply: ShellCompose["openReply"];
  /** The drafter, opened over the editor the `draft` verb has just raised. */
  draftReply: Pick<ShellCompose["draftReply"], "open">;
  /** Whether the open editor already answers everyone — a drafted text may not narrow it. */
  replyAll: boolean;
  /** The inline reply's id, the shell's own state, read only to keep that audience. */
  replyTo: string | null;
}

/** The record the shell composes with. Consumers destructure it: a memo may not depend on it. */
export type ShellVerbs = ReturnType<typeof useShellVerbs>;

export function useShellVerbs({
  engine, reader, t, toast, consent, nowAt, tags, ownAddresses,
  fileAndRefresh, toastWithUndo, mutateAndReport, mutateSetAndReport, mailboxesOf, refusalCopy,
  rosterRef, routing, deleting, restoring,
  markSeen, readerFor, setReaderFor, setPicker, setPickerIds, setSenderMenu, setSenderAudit,
  setSubjectRule,
  toggleReply, openForward, openReply, draftReply, replyAll, replyTo,
}: ShellVerbsInput) {
  /* ── shared actions ── */
  const openTagPicker = useStableCallback((messageId: string, anchor: HTMLElement | null) => {
    setPickerIds(null);
    setPicker({ forId: messageId, ...placePicker(anchor) });
  });

  /**
   * SCREENING FROM ANYWHERE — one call site for every surface. The plan comes from `sender-screening.ts`, which
   * decides whether the endpoint can be used at all; this only dispatches it and tells the truth about what happened.
   * THE RULE'S OUTCOME IS AWAITED, AND ONLY THE RULE'S: This used to toast on click for every outcome, which was
   * survivable while the only claim was "your mail moved" — a `move` that fails rolls its own row back on screen. It
   * stopped being survivable the moment the sentence started claiming something about FUTURE mail: the rules
   * surface's first cut printed "Rule revoked" over a 403 on a live account, and the fixtures adapter never refuses,
   * so every test was green. So `plan.ruleMutations` — and nothing else — is awaited, and `screeningToast` picks the
   * sentence from what the server actually said.
   */

  /**
   * The branch lives beside the sentences in `sender-screening.ts`, never here.
   */
  const changeScreening = useStableCallback((
    messageId: string,
    dest: ScreeningDest,
    scope: ScreeningScope = "sender",
    makeRule = true,
    // The sheet's second switch — whether the rule also reaches the mail already filed. Threaded
    // rather than defaulted here: the planner's default decides only what an untaught caller gets.
    applyRetro = RETRO_DEFAULT_ON,
    // The contact-chip override (viewer redesign): the sheet resolved a To/Cc address, so the
    // dispatch must resolve the SAME one — a plan computed from the message id alone would
    // preview one person's mail and move the sender's.
    address?: string,
  ) => {
    setSenderMenu(null);
    const sender = senderScreening(engine.verbRead(), messageId, address);
    if (!sender) return;
    const plan = planScreeningChange(sender, dest, scope, makeRule, applyRetro);
    const place = PLACE_LABEL[dest] ?? dest;
    // The SUBJECT of the sentence follows the scope, or a domain decision would report
    // itself as being about the one address the user happened to click.
    const who = scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address);
    if (plan.mutations.length === 0) {
      toast(t("screening.toastAlready", { sender: who, place }));
      return;
    }
    /* THROUGH `fileAndRefresh`, LIKE EVERY OTHER FILING DISPATCH. This one has not been since it
       shipped: the mail moved and the filing strip's count stayed stale until its next poll, up to
       thirty seconds later. Both Move arms already go through it. */
    void dispatchScreeningChange(plan, (m) => fileAndRefresh(engine.mutate(m))).then((key) => {
      toast(t(`screening.${key}`, { sender: who, place, count: plan.moved }));
    });
  });

  /**
   * MOVE, TO A PLACE THE ROUTER OWNS — and all five of the Move strip's destinations are.
   *
   * Reads is not a folder mail sits in: `consentPartition` PRESENTS a message at the place the
   * sender's rule names, so a newsletter shown there is physically in the INBOX. The strip
   * offered Ohbox against the presented place, the arm dispatched INBOX→INBOX, the engine
   * computed no effects, and the shell said "Moved to Ohbox." over an answer it had thrown away.
   * So the press writes the ROUTING — the fact that decides the place — and the row moves with
   * it, without a byte on the wire about folders. Plan and sentence are the Screener's own.
   */
  /**
   * ONE SENDER'S ROUTING, NARROWED TO THE MESSAGES THIS PRESS NAMED — the plan both Move arms
   * dispatch. The single-message arm passes the one id it was pressed on; the selection arm
   * passes that sender's picked ids. Nothing else differs between them, which is the point: a
   * second implementation of "move to a place" is what left the bulk arm writing folder moves
   * against the PRESENTED place — effectless, and its refusal discarded.
   */
  /**
   * What a Move press IS, in one shape: the plan, the name the sentence uses, the address the
   * window's journal keeps, and the rows the press named. Named rather than inlined because both
   * arms build it and one door consumes it — a second spelling is how the row that moves and the
   * rule that is written come to be about different people.
   */

  interface RoutingPressPlan {
    plan: ScreeningPlan;
    who: string;
    address: string;
    named: string[];
  }

  const planMoveToPlace = useStableCallback((
    seedId: string, view: OhmailView, only: ReadonlySet<string>, seed?: EngineMessage,
  ): RoutingPressPlan | null => {
    /* The verb reader — a History or Search row the mirror does not hold is planned like any
       other — and the pressed row itself, which a reading column can hold past its page. */
    const read = seed ? withRow(engine.verbRead(), seed) : engine.verbRead();
    const sender = senderScreening(read, seedId);
    if (!sender) return null;
    /* SENDER SCOPE AND NO RETRO: the press is about these messages, not a domain, and nobody
       asked the server to walk the backlog. */
    const planned = planScreeningChange(sender, view as ScreeningDest, "sender", true, false);
    /**
     * AND IT MOVES THE MESSAGE IT WAS PRESSED ON, not the sender's whole visible backlog.
     *
     * `planScreeningChange` files every out-of-place message of the subject it can see (up to its
     * cap) — right for the Screener's sheet, which SHOWS that count before the click, and wrong
     * for a press on one row: dragging one newsletter onto Reads would file the two beside it with
     * nothing having said so. The rule half is kept whole, because that IS the routing; the
     * `screener_decide` is kept whole too, because it re-files the mail it holds itself and
     * dropping it would leave a gate press writing nothing.
     */
    const kept = new Set<EngineMutation>([
      ...planned.ruleMutations,
      ...planned.mutations.filter((x) => x.kind === "screener_decide"),
    ]);
    /**
     * AND THE NAMED MESSAGES ARE MOVED, whatever the plan's own past-mail half decided.
     *
     * `planScreeningChange` writes those moves only when the person asked for the backlog, and
     * this press never does — so filtering the plan's moves now yields none and the mail the
     * press was made on would stay where it is under a rule that says otherwise. The plan's own
     * rule states it: with the move as the instruction there is no switch to gate on. So the ids
     * this press names are minted here, and only those — never the sender's visible backlog.
     */
    const wanted = FOLDER_OF_VIEW[view];
    const decided = planned.mutations.some((x) => x.kind === "screener_decide");
    const named: EngineMutation[] = decided ? [] : [...only]
      .map((id) => read.get<EngineMessage>("message", id))
      .filter((msg): msg is EngineMessage => msg != null && wanted != null && msg.folder !== wanted)
      .map((msg) => ({ kind: "move", messageId: msg.id, folder: wanted! }));
    const mutations = [
      ...planned.mutations.filter((x) => kept.has(x)),
      ...named,
    ];
    /* The decide re-files the mail it holds itself, so its own count is the plan's to state;
       otherwise it is what this press actually names. */
    const moved = decided ? planned.moved : named.length;
    /* The NAME on the row, and the address only when the row carries no name. */
    const who = sender.name && sender.name.trim() ? sender.name.trim() : displayAddress(sender.address);
    /* AND WHO IT IS ABOUT, in the form the window's journal keeps: the address is what the
       commit re-reads the ladder from, and the named ids are what the overlay shows moved. The
       press does not re-derive either — a second derivation is how the row that moves and the
       rule that is written come to be about different people. */
    return { plan: { ...planned, mutations, moved }, who, address: sender.address, named: [...only] };
  });

  /** Whether a plan's routing half carries a Screener decision — see {@link fileThroughRouting}. */
  const decidesAtGate = (plan: ScreeningPlan): boolean =>
    splitRoutingPlan(plan).routing.some((mu) => mu.kind === "screener_decide");

  /**
   * ONE ROUTING PRESS — TWO HALVES AND ONE SENTENCE, and every Move arm comes through here. The
   * MAIL moves now through the ordinary filing dispatch, with the engine's own reversal read off
   * the mirror BEFORE it is sent. The ROUTING is HELD for the undo window (`routing-undo.ts`),
   * one intent per SENDER, so a selection spanning six is six intents and ONE toast whose Undo
   * takes back all of it. Nothing about a rule's wire changes; it is sent when the window closes,
   * and only a differing answer earns a correction.
   */
  /**
   * A PLAN CARRYING A `screener_decide` NEVER REACHES HERE, and that is not an omission: the
   * Screener hides a decided sender from its queue through its OWN pending state, so a decision
   * held here would leave that sender pressable at the gate for the length of the window — two
   * consent records for one sender, the shape `screener-state.ts` refuses inside itself. The
   * callers split those off onto the path they have always taken, with no Undo.
   */
  const fileThroughRouting = useStableCallback((input: {
    plans: readonly RoutingPressPlan[];
    view: OhmailView;
    /** What the press says, in the caller's own vocabulary — one sentence for the whole press. */
    sentence: string;
    /** What Undo says once every held rule has been taken back. */
    undone: string;
  }): void => {
    const place = PLACE_LABEL[input.view] ?? input.view;
    /* ONE PRE-PRESS READ FOR THE WHOLE PRESS: the inverses name the state this press is about to
       leave, and a read taken after the first dispatch would already describe the new one. */
    const pre = engine.verbRead();
    const inverses: EngineMutation[] = [];
    const subjects: string[] = [];
    let lost = false;
    for (const planned of input.plans) {
      const { mail, routing: rules } = splitRoutingPlan(planned.plan);
      for (const mu of mail) inverses.push(...inverseMutations(pre, mu));
      for (const mu of mail) void fileAndRefresh(engine.mutate(mu));
      if (rules.length === 0) continue;
      const opened = routing.hold({
        id: crypto.randomUUID(),
        seedId: planned.named[0] ?? "",
        address: planned.address,
        dest: input.view as ScreeningDest,
        messageIds: planned.named,
        note: { sender: planned.who, place, count: planned.plan.moved },
      });
      if (opened.held) subjects.push(routing.subjectOf(planned.address));
      else lost = true;
    }
    /* A JAR THAT REFUSED THE RECORD HAS ALREADY SENT THE RULE — and it refused for the BROWSER,
       not for this press, so the whole sentence says the undo is not on offer rather than
       offering one over the half that happened to land. `delete-undo.ts`'s degradation, same
       words. */
    if (lost) { toast(`${input.sentence} ${t("session.noUndoHere")}`); return; }
    /* WHETHER A ROUTING PRESS IS UNDOABLE AT ALL IS THE ENGINE'S ANSWER, read from the one
       table every surface reads (`UNDO_CLASS`), and this press's own `held` is the second
       question. A boolean decided here would be a second opinion that can disagree with the
       table — which is the drift the table exists to make impossible. */
    if (UNDO_CLASS.routing_plan !== "window" || subjects.length === 0) {
      toastWithUndo(input.sentence, inverses);
      return;
    }
    toastWithUndo(input.sentence, inverses, {
      /* EVERY HELD SENDER, and `true` only if at least one window was still open: a press whose
         windows have all closed took nothing back, and the sentence must not say otherwise. */
      cancel: () => subjects.map((x) => routing.undo(x)).some(Boolean),
      undone: input.undone,
    });
  });

  const moveToPlace = useStableCallback((m: EngineMessage, view: OhmailView) => {
    const planned = planMoveToPlace(m.id, view, new Set([m.id]), m);
    /* The pressed row is its own seed, so there is always a sender to route. */
    if (!planned) return;
    /* NO EMPTY-PLAN SHORTCUT, deliberately: a plan with nothing in it dispatches nothing and
       `screeningToast` answers `toastAlreadyRuled` off `ruleState` alone, so the one path already
       speaks for the press that changes nothing. A branch here would be a second sentence on a
       state the strip's own filter makes all but unreachable — unwatchable, and the shape this
       arm shipped with. */
    const place = PLACE_LABEL[view] ?? view;
    const said = screeningToast(planned.plan, null);
    const sentence = t(`screening.${said}`, {
      sender: planned.who, place, count: planned.plan.moved,
    });
    /* A DECIDE KEEPS ITS OWN PATH — see `fileThroughRouting`'s note. Its sentence is the one the
       server earned, awaited exactly as it always has been. */
    if (decidesAtGate(planned.plan)) {
      void dispatchScreeningChange(planned.plan, (mu) => fileAndRefresh(engine.mutate(mu)))
        .then((key) => {
          toast(t(`screening.${key}`, { sender: planned.who, place, count: planned.plan.moved }));
        });
      return;
    }
    fileThroughRouting({
      plans: [planned],
      view,
      sentence,
      undone: t("screening.toastRoutingUndone"),
    });
  });

  /**
   * Open the detail view for whichever scope the sheet was showing.
   *
   * The rows are attributed HERE, at open time, rather than inside the panel: the panel then
   * holds a plain snapshot and cannot re-derive a different answer on a re-render caused by a
   * sync drain landing mid-read. The sheet closes, because the panel replaces it.
   */
  const openSenderAudit = useStableCallback((messageId: string, scope: ScreeningScope, address?: string) => {
    setSenderMenu(null);
    const sender = senderScreening(engine.verbRead(), messageId, address);
    if (!sender) return;
    setSenderAudit({
      title: scope === "domain" ? displayDomain(sender.domain) : displayAddress(sender.address),
      domain: scope === "domain",
      rows: attributeMessages(reader, sender.scopes[scope].messages),
    });
  });

  /**
   * `address` is the contact-chip override (viewer redesign): the sheet then resolves that To/Cc
   * address rather than the message's sender — see `SenderMenuState.address`. Every caller
   * that predates chips passes two arguments and gets the sender, unchanged.
   */
  const openSenderMenu = useStableCallback((messageId: string, anchor: HTMLElement | null, address?: string) => {
    setSenderMenu({ messageId, address, ...placePicker(anchor) });
  });

  /**
   * OPEN THE SUBJECT-RULE SHEET — from a message's title, and from the sender popover's last row.
   * `chrome.openSubjectRule` has been a declared seam with nothing behind it since the reading surface landed; this
   * fills it. The anchor is the pressed element where there is one — the title button dispatches
   * `openSubjectRule(id)` with no element, so the sheet is placed by `placePicker(null)`, exactly as a
   * keyboard-invoked tag picker is. It CLOSES the sender popover, because the subject sheet replaces it: they answer
   * the same question about different halves of one message and two open sheets is two questions.
   */
  const openSubjectRule = useStableCallback((messageId: string, anchor: HTMLElement | null = null) => {
    setSenderMenu(null);
    setSubjectRule({ messageId, ...placePicker(anchor) });
  });

  /**
   * The two gates the split views' message verbs borrow. Folder, Tag and History declare the nine message verbs over
   * their OWN cursor (`useMessageVerbs`) because the bindings below act on `focused`, and a split view's cursor is
   * state this shell cannot see; two verbs are gated on facts that live here and nowhere else, so they are resolved
   * here and passed down rather than re-derived in three view files — which is how the `?` sheet comes to advertise a
   * delete the bar refuses to draw. `canDeleteMessage` is the delete strip's own render gate, verbatim from the `d`
   * binding: the verb reader holding the row (the mirror, or its History/Search page). `canReplyAllTo` is
   * `replyAllRecipients` against the account's addresses — the same call the bar's button and `⇧R` make, and the one
   * `sendReply` resolves again at send time.
   */

  /**
   * "Use folders" is not a term here any more — it was the first, and wrong twice over. Delete is a move to the mail
   * server's OWN \Trash, a system folder discovered at connect, never a folder the user made, so the user-FOLDERS
   * flag was never a fact about this verb (the server's `message_delete` has never read it). And the same verb over a
   * SELECTION never read it either (`OhboxView`'s bulk delete opens on `picked.size > 0`), so one account could file
   * a pile to Trash by picking it and could not file the row under the cursor — measured live on a folders-off
   * account: the selection press produced "Moved to Trash." and a `DELETE /messages/:id`, the cursor press produced
   * nothing at all. Two admissions for one verb made that possible, so this is now the one admission both doors ask,
   * and it asks only what it can act on.
   */

  /**
   * The flag is still supplied on the chrome and read where it IS a fact: the folders rail group, the folder views,
   * and Move-to-folder.
   */
  const canDeleteMessage = useStableCallback((m: EngineMessage): boolean =>
    engine.verbRead().get<EngineMessage>("message", m.id) != null);
  const canReplyAllTo = useStableCallback((m: EngineMessage): boolean => replyAllRecipients(m, ownAddresses) !== null);

  /**
   * WRITE THE TWO-TERM RULE, AND SAY ONLY WHAT THE SERVER CONFIRMED. The plan comes from `subject-rule.ts`; this
   * dispatches it. The RULE mutation is awaited and the moves are not — the same split `dispatchScreeningChange`
   * documents at length, for the same reason: a `move` that fails rolls its own row back on screen, while "future
   * mail files there too" is a claim about the server that a refusal falsifies. The fixtures adapter never refuses,
   * so a toast fired on click would be green in every test and wrong on a live account. Dispatched here rather than
   * inside the sheet so the sheet stays a pure render of a plan, and so the awaiting is testable without a DOM.
   */
  const confirmSubjectRule = useStableCallback((messageId: string, term: string, dest: ScreeningDest, field: TermField = "subject", applyRetro = RETRO_DEFAULT_ON) => {
    setSubjectRule(null);
    const ctx = subjectRuleContext(reader, messageId);
    if (!ctx) return;
    const plan = planSubjectRule(ctx, term, dest, field, applyRetro);
    const place = PLACE_LABEL[dest] ?? dest;
    const rules = plan.ruleMutations.map((m) => engine.mutate(m));
    for (const m of plan.mutations) {
      if (!plan.ruleMutations.includes(m)) void engine.mutate(m);
    }
    void Promise.all(rules).then((results) => {
      const key = subjectRuleToast(plan, worstStatus(results));
      // The count is `matched`, not `outOfPlace`: the sentence is about the mail the rule NAMES,
      // which is what the confirm row showed. Reporting the smaller number afterwards would read
      // as the rule having done less than it said. The confirmed sentence names the FIELD the
      // term reads (mail 0052), because "in the subject" about a text rule is a false claim.
      toast(t.has(`screening.${key}`)
        ? t(`screening.${key}`, { sender: displayAddress(ctx.address), place, count: plan.matched, term: plan.term })
        : key === "subjectAlready"
          ? `You already had that rule. Nothing changed.`
          : key === "subjectRuleFailed"
            ? `That rule wasn't saved. Nothing has moved.`
            : key === "subjectRuleQueued"
              ? `Rule saved here. We'll send it when you're back online.`
              : plan.field === "body"
                ? `Mail from ${displayAddress(ctx.address)} with »${plan.term}« in the text now files to ${place}.`
                : `Mail from ${displayAddress(ctx.address)} with »${plan.term}« in the subject now files to ${place}.`);
    });
  });

  /**
   * Clicking a sender's circle or address, on ANY surface that shows one. One capture-phase handler on the stage
   * rather than one per view: `MessageRow` renders a `<button>`, so a second interactive control cannot nest inside
   * it, and every list already stamps `data-id`. Capture runs before the row's own click, so this opens the screening
   * popover INSTEAD of moving the cursor; Shift is left alone — that gesture belongs to the Ohbox's range selection.
   * The reading surfaces too, not only the lists: the selector used to be `.row`-only, so screening a sender was
   * reachable everywhere except Reads and Receipts — the two views whose whole content is mail from senders you might
   * want to stop hearing from, with the address right there on every card.
   */

  /**
   * `.scast` stamps `data-sid` where a row stamps `data-id`; the anchor handed to `placePicker` is the card, exactly
   * as it is the row; `stopPropagation` keeps the card's own `onSelect` from firing, same as for rows. The hit test
   * is `sender-hit.ts` — a pure function of one element, so which elements count as "the sender" can be asserted
   * without standing up an engine and a router.
   */
  const onStageClickCapture = useStableCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (e.shiftKey) return;
    const hit = senderHitOf(e.target as HTMLElement);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    openSenderMenu(hit.id, hit.anchor);
  });

  const revokeRule = useStableCallback((ruleId: string) => engine.mutate({ kind: "rule_delete", ruleId }));

  const retargetRule = useStableCallback((ruleId: string, destination: Folder) => engine.mutate({ kind: "rule_update", ruleId, destination }));

  const toggleTag = useStableCallback((messageId: string, tagId: string, assigned: boolean) => {
    const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
    void mutateAndReport(
      { kind: "tag_assign", messageId, tagId, assigned },
      assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }),
    );
  });

  /**
   * The same verb over a SET — and it is `tag_assign` fanned out. No new bulk mutation kind: `tag_assign` is
   * per-message on the wire, the round trips are one per message that actually CHANGES, and a selection is a handful
   * of rows rather than a pile. Inventing a bulk kind would mean a second server route to keep honest for a cost
   * nobody has measured — the brief asks for a measurement before that claim, and there is none, so the fan-out
   * stands. Messages that already agree with the target state are skipped. `tag_assign` is idempotent, so this is not
   * correctness — it is not asking a server to restate forty things it already holds.
   */
  const bulkToggleTag = useStableCallback((ids: string[], tagId: string, assigned: boolean) => {
    const name = tags.find((x) => x.id === tagId)?.name ?? tagId;
    const targets = ids.filter((id) => {
      const m = engine.verbRead().get<EngineMessage>("message", id);
      return m != null && m.labels.includes(tagId) !== assigned;
    });
    if (targets.length === 0) return;
    /* The COUNT IS WHAT APPLIED, not what was picked — the set seam answers with it, so a press
       that reached three of five says three rather than claiming the two the server refused. */
    void mutateSetAndReport(
      targets.map((messageId) => ({ kind: "tag_assign", messageId, tagId, assigned } as const)),
      (applied) => (applied === 1
        ? (assigned ? t("tag.toastTagged", { name }) : t("tag.toastUntagged", { name }))
        : (assigned
          ? t("tag.toastTaggedMany", { name, count: applied })
          : t("tag.toastUntaggedMany", { name, count: applied }))),
    );
  });

  /**
   * A TAG DROPPED ON THE RAIL — apply, never toggle.
   *
   * The rail-drop gesture (`shell/drag-file.ts`, wired in `OhboxView`) names its tag by the
   * row it landed on, so it needs no picker; what it must NOT have is a second tagging
   * semantic. This is `bulkToggleTag` in the apply direction and nothing else: the same
   * per-message `tag_assign`, the same skip of members that already carry it, the same
   * sentence at the end. A drop can never REMOVE a tag — the drop's meaning is "put it
   * here", and the picker remains the place where a tag is taken off.
   */
  const dropTag = useStableCallback((ids: string[], tagId: string) => bulkToggleTag(ids, tagId, true));

  /**
   * Mint a tag and put it on this message. ONE mutation, not two. The shell cannot call the API directly —
   * `scripts/publish-desktop.mjs` DENYs `app/api-client` from this shared shell — so the engine is the only wire, and
   * `tag_assign` carries the new name rather than a second `tag_create` verb: a create that succeeded followed by an
   * assign that failed would leave an empty tag the user never asked for, and the two-request version has no
   * transaction to undo it. The id is minted HERE so the optimistic effect paints the same tag the database stores.
   * If the name already exists the server's row wins and this id is simply never seen — the chip then appears on the
   * next drain under the real id, which is why nothing here asserts the tag is visible yet.
   */
  const createTag = useStableCallback((messageId: string, name: string) => {
    void mutateAndReport(
      { kind: "tag_assign", messageId, tagId: crypto.randomUUID(), assigned: true, createName: name },
      t("tag.toastTagged", { name }),
    );
  });

  /**
   * THE TAG, WITHOUT A MESSAGE: Reported as: the sidebar should let you add tags, and Settings → Tags is not
   * implemented. Both had one cause — `tag_assign`'s tag-or-create was the only way to mint a tag, so a name had to
   * be attached to a message to exist, and there was no rename or delete verb at all. `POST /tags`, `PATCH /tags/:id`
   * and `DELETE /tags/:id` had been mounted the whole time with no caller; these three are the callers. The id is
   * minted here for the optimistic row only. `POST /tags` lets the DATABASE choose the id (unlike tag-or-create,
   * which mints under the client's), so this uuid names a row that lives exactly as long as the overlay — see the
   * mutation's own comment.
   */
  const createTagAlone = useStableCallback((name: string) => {
    void mutateAndReport({ kind: "tag_create", tagId: crypto.randomUUID(), name }, t("tag.toastCreated", { name }));
  });

  const renameTag = useStableCallback((tagId: string, name: string) => {
    void mutateAndReport({ kind: "tag_rename", tagId, name }, t("tag.toastRenamed", { name }));
  });

  /**
   * The name is read BEFORE the mutation. Afterwards the optimistic effect has already
   * tombstoned the row, so `reader.get` answers undefined and the sentence would be about a
   * tag it could not name.
   */
  const deleteTag = useStableCallback((tagId: string) => {
    const name = reader.get<TagDTO>("tag", tagId)?.name ?? "";
    void mutateAndReport({ kind: "tag_delete", tagId }, t("tag.toastDeleted", { name }));
  });
  /**
   * Recolour a tag. NO toast, deliberately: the dot changes colour in place, which is the
   * confirmation — a "Recoloured Invoices" toast would restate a change the eye already saw. The
   * picker only ever passes a renderable hue (`TAG_HUES`), and the server accepts exactly those,
   * so this cannot store a colour nothing can draw.
   */
  const recolorTag = useStableCallback((tagId: string, hue: string) => {
    /* Through the seam with no sentence of its own — the dot changing colour IS the confirmation.
       A refusal still speaks: the seam says so, which is the half that was missing. */
    void mutateAndReport({ kind: "tag_recolor", tagId, hue }, null);
  });
  const tagAdmin = useMemo(
    () => ({ onCreate: createTagAlone, onRename: renameTag, onRecolor: recolorTag, onDelete: deleteTag }),
    [createTagAlone, renameTag, recolorTag, deleteTag],
  );

  /** The last verb's subject, for the pane's after-verb reaction — see `after-verb.ts`. */
  const lastActed = useRef<ActedMarker | null>(null);

  const onMessageAction = useStableCallback(
    (action: MessageAction, m: EngineMessage) => {
      /* THE ACTED MARKER: every message verb — key, bar, palette, sheet — funnels through
         here, so this one write is what lets the Ohbox pane tell "my verb moved the open row"
         from a drain applying another device's work. A ref: the pane reads it when the row
         actually leaves, and nothing re-renders for the write itself. */
      lastActed.current = { id: m.id, at: Date.now() };
      switch (action) {
        case "reply":
          // Inline, in place. This used to be `setReaderOpen(false); go("compose")` —
          // the message you were answering left the screen as you started answering it.
          // A TOGGLE: the same button on the same open editor closes it (see `toggleReply`).
          toggleReply(m.id);
          break;
        case "reply_all":
          // The same editor, opened over the whole audience. The bar only dispatches this
          // where `replyAllRecipients` admitted a control (see `MessagePane.ActionBar`), and
          // `sendReply` resolves that same call again for the wire. A toggle like plain Reply.
          toggleReply(m.id, true);
          break;
        case "forward":
          /**
           * THE BAR'S FORWARD, answered by the seam the panel ⋯ menus have always dispatched.
           *
           * NOT `toggleReply`-shaped, deliberately: `openForward` ASKS before a `no_forward` original
           * with a toast, and a toggle would read that refusal as "the editor is already open on
           * this message, close it" on the second press. It is also not a second implementation —
           * one open, one refusal, one scratch lane.
           */
          openForward(m.id, m);
          break;
        case "draft":
          /**
           * IT NOW ASKS THE DRAFTER, and it used to navigate to Compose.
           *
           * `setReaderFor(null); go("compose")` took the message off the screen and left the
           * user in an empty compose form with no draft in it and nothing having been
           * requested — `POST /messages/:id/draft` has been live for months with no caller.
           * The reply editor is opened first so the offer has somewhere to render and so the
           * price sits beside the box the text will land in; the offer spends nothing until
           * it is confirmed.
           */
          // The open KEEPS the audience an editor already holds on this message — a drafted
          // text bought for a reply-all must not silently narrow the envelope to the sender.
          openReply(m.id, replyTo === m.id && replyAll);
          draftReply.open(m.id);
          break;
        /**
         * THE THREE HORIZONS ARE TOGGLES — the way OUT of a pile: The wire has carried `state:"none"` since the
         * triage route shipped (`TriageWireState`; `TriageService.setState` accepts it) and NOTHING in the UI ever
         * dispatched it: the footer only switched piles, the ⋯ menu and ⌘K had no verb, and the key that filed a
         * message answered a re-press with a toast about being already queued. One mis-key was irreversible until
         * reply or resurface. So the verb that put a message IN a pile takes it out again — the same convention `r`
         * (reply editor) and `u` (read state) already keep, reached from the same three places at once because the
         * key, the footer button and the palette all dispatch through here. The toast states the direction each press
         * actually took.
         */
        case "later":
          if (m.triage?.state === "reply_later") {
            void mutateAndReport({ kind: "triage_set", messageId: m.id, state: "none" }, t("ohbox.toastUnqueued"));
          } else {
            void mutateAndReport(
              { kind: "triage_set", messageId: m.id, state: "reply_later" },
              t("ohbox.toastQueued"),
            );
          }
          break;
        case "aside":
          if (m.triage?.state === "set_aside") {
            void mutateAndReport({ kind: "triage_set", messageId: m.id, state: "none" }, t("ohbox.toastUnparked"));
          } else {
            void mutateAndReport(
              { kind: "triage_set", messageId: m.id, state: "set_aside" },
              t("ohbox.toastAside"),
            );
          }
          break;
        case "unread":
          /**
           * THE READ TOGGLE'S FALLBACK ARM, and it is deliberately not the normal path.
           *
           * In the product the bar's switch presses `u` itself, so this is reached only
           * where that binding does not exist — the desktop shell, or a pane mounted with no
           * keymap provider. It goes through the same `markSeen` every other read-state path
           * in this file goes through, which is what keeps "one call site for one mutation"
           * true; what it CANNOT do from here is set `OhboxView`'s `pinnedUnread`, which is
           * exactly why the button prefers the key. See `ActionBar` in `MessagePane.tsx`.
           */
          // `!m.unread` is the DESIRED state, written the way `OhboxView.toggleUnread`
          // writes it — one expression for "flip it", not two that could drift apart.
          markSeen([m.id], !m.unread);
          break;
        case "resurface": {
          // A message already scheduled: the horizon-less verb CLEARS the booking rather than
          // silently re-dating it — the toggle rule above, and the only way to take back a
          // resurface that the popover's picker cannot offer (it has no "cancel this" row).
          if (m.triage?.state === "bubbled_up") {
            void mutateAndReport(
              { kind: "triage_set", messageId: m.id, state: "none" },
              t("ohbox.toastResurfaceCleared"),
            );
            break;
          }
          // The horizon-less default — the keyboard's `b` and the palette. The popover on the
          // bar dispatches `resurface:<iso>` instead, handled in `default` below. TOMORROW at the
          // account's resurface time, the picker's own first dated preset — it was next Friday,
          // a horizon the picker never offers, so the key's outcome could not be reproduced (or
          // predicted) from the control that documents the verb. The HOUR comes from the same
          // place the strip's control shows (mail 0110): a key that kept minting 09:00 after
          // somebody set 14:30 would be the one resurface in the product that ignored the
          // default, and nothing on screen would say so.
          const when = tomorrowAt(nowAt(), consent.resurfaceTime).iso;
          void mutateAndReport(
            { kind: "triage_set", messageId: m.id, state: "bubbled_up", bubbleUpAt: when },
            t("ohbox.toastResurface", { when: resurfaceLabel(when) }),
          );
          break;
        }
        case "delete": {
          /**
           * The delete verb — a move to the provider's native \Trash, NEVER an expunge (FOLDERS-SPEC.md §16.3; the
           * third user-commanded write). Still the ONE dispatch site: the confirm strip the ⋯ menu opens
           * (`MessagePane.ActionBar`) and the Backspace/Delete keys both arrive here — one ceremony, one sentence. It
           * now carries an Undo, which it did not: "there is no un-delete on the wire" is still true, and what
           * changed is that the press no longer dispatches — it opens a window.
           */

          /**
           * `delete-undo.ts` hides the row at once, the toast carries Undo for `UNDO_MS`, and the mutation goes out
           * only when the window closes; an Undo inside it cancels a delete that never happened, the only undo this
           * wire can honour, and the Screener's own answer to the identical fork. A reader is refused BEFORE any of
           * that, in `refuseMove`'s exact words: a delete is a folder move against mail another install is arranging
           * — nothing hidden, nothing on the wire (see `readerMoveRefusal`). The reader sheet is closed on the way,
           * and only for THIS message: the mirror holds the row for the length of the window, so `readerMessage`
           * would otherwise keep a sheet standing over mail every list has let go of.
           */
          /* THE REFUSAL DECIDES FIRST, and the sheet closes only if the press acted. Reversed,
             a refused reader delete closed the reading sheet over the very message it had just
             declined to touch — the person is left looking at a list, told nothing moved, with
             the message they were reading gone from the screen (review finding). */
          if (deleting.remove({ id: m.id, mailboxId: m.mailboxId }) && readerFor === m.id) {
            setReaderFor(null);
          }
          break;
        }
        case "restore": {
          /**
           * Restore — the Trash pane's one primary verb, and `⇧⌫` there. Held exactly as the delete is: there is no
           * un-restore on the wire (a second press would 409 `not_in_trash`, true but not an undo), so the only undo
           * this wire can honour is the delayed commit — the row leaves the Trash list at the press, the toast
           * carries Undo for `UNDO_MS`, and `POST /messages/:id/restore` goes out when the window closes (the
           * `restoring` window above owns all of that).
           */

          /**
           * The place is named by the SERVER, afterwards: the row's own `restoreTo` is what the LIST was rendered
           * with, and the origin folder can be deleted between the page and the press — so the place sentence is
           * raised by the window's DISPATCH, when the server has answered; raising it here would need a second
           * `restoreFromTrash` call that issues immediately and cancels the undo window with every guard still green
           * (see `restoreDispatch`). A press that never reaches the server raises no place sentence — the window's
           * `failed` arm says the mail is still in Trash. The reader sheet closes only if the press ACTED, the delete
           * arm's own ordering: reversed, a refused reader restore closed the sheet over the very message it had
           * declined to touch.
           */
          if (restoring.remove({ id: m.id, mailboxId: m.mailboxId }) && readerFor === m.id) {
            setReaderFor(null);
          }
          break;
        }
        case "resurface_now":
          /**
           * "NOW" IS A STATE, NOT A DATE, and that is the only thing separating this arm from the one above it.
           * `bubbled_up` with a past `bubbleUpAt` would pin nothing until a bubble-up pass ran, and the pass is not a
           * promise this product can make at this latency — it is gated inside the worker's cycle, and a standalone
           * desktop install runs no worker at all. So the mutation asks for the state the schedule exists to reach,
           * the server writes it in one transaction, and `ohboxView.resurfaced` has the row on the next drain. No
           * `bubbleUpAt`: there is no schedule to spend.
           */
          void mutateAndReport(
            { kind: "triage_set", messageId: m.id, state: "resurfaced" },
            t("ohbox.toastResurfaceNow"),
          );
          break;
        case "resurface_done": {
          /**
           * THE DELIBERATE RELEASE, NAMED — "Done" on a resurfaced or scheduled message. FOR A PINNED MESSAGE IT IS
           * ONE MUTATION AND IT ALREADY EXISTED: a deliberate `mark_seen` (no `via`) spends the pin in the same act
           * on both sides of the wire (`spentResurface` in the overlay, `MessageService.spendResurface` in the
           * route's transaction), stamps `lastReadAt`, and the row files at the top of "Earlier" — the choreography
           * `OhboxView.slideOut` already draws. Nothing new is dispatched for it, deliberately: a second wire verb
           * for the same release would be two writers of one fact. FOR A SCHEDULED MESSAGE (`bubbled_up`, sitting in
           * the Resurface pile) the release has an extra half: the booking is cleared FIRST (`triage_set: none` — the
           * same un-triage the horizon toggles use), then the same deliberate read files it.
           */

          /**
           * Same end state, never a new one: unscheduled, read, top of "Earlier". Skipping the clear would leave the
           * pile listing a message the reader just said they were done with.
           */
          /* AND THE SENTENCE FOLLOWS THE ANSWER. A reader install cannot triage: the clear was
             refused, the engine rolled it back, and this arm reported "filed under Earlier" over
             a booking that still stood and mail that still came back. A refused clear means the
             schedule is intact, so the deliberate read that would file the row is never sent —
             half a release is a message read out of a pile it is still in. */
          const release = async (): Promise<void> => {
            /* Both halves' inverses, off the pre-press mirror: the deliberate read's (re-pin a
               spent pin, unread back) and the booking clear's (re-book at its own date). A row
               is pinned OR booked, never both, so the two reads cannot overlap. */
            const pre = engine.verbRead();
            const inverses = [
              ...inverseMutations(pre, { kind: "mark_seen", messageIds: [m.id], unread: false }),
              ...(m.triage?.state === "bubbled_up"
                ? inverseMutations(pre, { kind: "triage_set", messageId: m.id, state: "none" })
                : []),
            ];
            if (m.triage?.state === "bubbled_up"
              && !(await mutateAndReport({ kind: "triage_set", messageId: m.id, state: "none" }, null))) return;
            /* WHERE IT WENT, named: Earlier is one chronology, so a ten-day-old row files ten
               days down — "filed under Earlier" alone read as "gone" (owner, 2026-09-21). */
            if (await markSeen([m.id], false)) {
              toastWithUndo(t("ohbox.toastResurfaceDone", { when: dayStamp(m.date) }), inverses);
            }
          };
          void release();
          break;
        }
        default: {
          // RESURFACE AT A CHOSEN INSTANT — the bar's popover feeds the day here. The wire has
          // always carried an arbitrary `bubbleUpAt`; this is the caller that fills it with
          // something other than the Friday default, and `resurfaceLabel` states whichever day
          // it is.
          if (action.startsWith("resurface:")) {
            const when = action.slice("resurface:".length);
            void mutateAndReport(
              { kind: "triage_set", messageId: m.id, state: "bubbled_up", bubbleUpAt: when },
              t("ohbox.toastResurface", { when: resurfaceLabel(when) }),
            );
            break;
          }
          // `move:<view>` — the destination travels with the action. Before
          // this the whole branch was a toast reading "Demo — Move isn't wired yet.",
          // rendered on live accounts; the mutation was already on the wire.
          const view = action.slice("move:".length) as OhmailView;
          /* The destination has to BE one — an unknown view is the only thing this cannot act on,
             and `moveToPlace` says so for every other outcome including "nothing needed moving".
             The old second clause (`folder === m.folder`) compared the destination against the
             PRESENTED place and broke out in silence when they matched; that comparison is now the
             plan's, over the mirror, where a folder is a fact. */
          if (!FOLDER_OF_VIEW[view]) break;
          /**
           * A READER MOVES NOTHING, AND HEARS SO BEFORE ANYTHING LEAVES. This arm used to dispatch and let the server
           * refuse: the row left the list, the request was declined, the engine rolled the optimistic overlay back,
           * and the message reappeared a beat later with no sentence explaining why. The rule was already written
           * once and asked by three other callers — the Screener's own bar, the delete window, and the SELECTION's
           * move — so it is asked here in the same words, from the same helper, at the same moment: at the press,
           * before the wire. `roleRef` and not `screenerRole`: the refusal answers with the role at PRESS time, which
           * is the whole reason that ref exists.
           */
          const refusedMove = readerMoveRefusal(
            rosterRef.current,
            [m.mailboxId ?? ""],
            refusalCopy,
          );
          if (refusedMove !== null) {
            toast(refusedMove);
            break;
          }
          moveToPlace(m, view);
          break;
        }
      }
    },
  );

  /**
   * The same verbs, pressed from a stream card. Reads and Receipts read in the card and mount no `ReadingPane`, which
   * is exactly why they had no verbs; they have the Ohbox's bar now (`MessageActionBar`), and every action means here
   * what it means there — this delegates and invents nothing. The ONE addition is a place for an answer to be
   * written: `reply` and `draft` open the inline editor, which renders inside a message pane, and a stream has none —
   * pressing Reply on a card would set a draft nobody can see. The reader sheet IS a message pane over the current
   * message, so it is raised first and the editor lands in it (both are state setters, batched into one render).
   * Every other action is a mutation with a toast and needs no surface, passed straight through.
   */

  /**
   * `forward` is in the same list as `reply` and not a fourth case: the inline forward IS the reply dock in forward
   * mode (`openForward`), so it needs the identical pane — left out, Forward on a card would set `replyTo` with
   * nothing mounted to render it, the dead-button shape this list exists to prevent.
   */
  const onStreamAction = useStableCallback((action: MessageAction, m: EngineMessage) => {
    if (action === "reply" || action === "reply_all" || action === "forward" || action === "draft") {
      setReaderFor(m.id);
    }
    onMessageAction(action, m);
  });

  /**
   * THE SELECTION'S VERBS: The requirement: a selection must offer more than mark unseen, mark read and Escape — it
   * needs the sender's screening and its tags too. The count was exact: ⇧U and Escape, in one view. The vocabulary is
   * the ACTION BAR's, not a second one invented for bulk — the same three horizons, the same two filing verbs, the
   * same read state. Reply is the one verb that is dropped, because "reply to eleven messages" is not a thing the
   * product can mean. Everything here dispatches through the ordinary engine path, one mutation per message, and says
   * ONE sentence at the end. A per-message toast over a selection of forty is not feedback, it is a denial of service
   * on your own screen.
   */
  /**
   * The selection's verbs — and whether the selection SURVIVES the press. It returns a boolean now, and the boolean
   * is the refusal: every verb here used to end the selection unconditionally, because every verb used to happen; a
   * reader's Move does not, and a set cleared by a press that did nothing leaves the person to rebuild it. `true` ⇒
   * dispatched, clear the pick; `false` ⇒ refused at the press, keep it — the Ohbox reads exactly that. A reader is
   * refused HERE, before the wire, and once: `move:*` used to dispatch one `move` per message with no role check —
   * the rows left the list, the server refused each, and they came back, a rollback per message for a decision the
   * client could answer instantly. The rule already existed one module over (`readerMoveRefusal`), so this asks it
   * too: one toast, nothing dispatched, the pick kept.
   */

  /**
   * Filing verbs only — `move:*` here, `screen` in `onBulkScreen`, `delete` through the window's own `refusal`; Read,
   * Unread, Tag and the three horizons are not folder moves and are not refused — a reader "reads, searches, marks
   * read and sends", and refusing those would withhold presses that work.
   */
  const onBulkAction = useStableCallback(
    (action: BulkAction, ids: string[]): boolean => {
      if (ids.length === 0) return false;
      if (action === "delete") {
        /* ONE WINDOW, ONE TOAST, ONE UNDO FOR THE SET — `delete-undo.ts` keyed by press. The
           reader refusal is the window's own (`refusal`, resolved at the press), so this arm
           does not repeat it: two spellings of one verdict is the drift that helper exists to
           end. The ASK — the confirm strip for `d` and the menu item, nothing for ⌫/⌦ — has
           already happened in the view; the window is still the only dispatch site. */
        return deleting.remove(
          ids.map((id) => ({ id, mailboxId: engine.verbRead().get<EngineMessage>("message", id)?.mailboxId })),
        );
      }
      if (action === "read" || action === "unread") {
        // The batch mutation, unchanged: one request, one transaction, one intent — and the
        // sentence now waits for its verdict, like every other press in this file. The inverse
        // is read before the dispatch, so Undo flips back exactly the ids this press flipped.
        const inverses = inverseMutations(
          engine.verbRead(),
          { kind: "mark_seen", messageIds: ids, unread: action === "unread" },
        );
        void markSeen(ids, action === "unread").then((ok) => {
          if (ok) {
            toastWithUndo(
              t(action === "unread" ? "ohbox.toastBulkUnread" : "ohbox.toastBulkRead", {
                count: ids.length,
              }),
              inverses,
            );
          }
        });
        return true;
      }
      if (action === "done") {
        /**
         * THE CONVERSATION'S RELEASE — the row's Done, over every member carrying a pin. Two
         * halves in order, the same two the single-message arm runs: the BOOKINGS go first
         * (`bubbled_up` rows have a schedule to clear, and a read left under one is a message
         * read out of a pile it is still in), then ONE deliberate `mark_seen` over the whole set
         * spends the pins in a single transaction. A refused clear stops the read: half a release
         * is worse than none, and a reader install cannot triage at all.
         */
        const rows = ids
          .map((id) => engine.verbRead().get<EngineMessage>("message", id))
          .filter((m): m is EngineMessage => m != null);
        const booked = rows.filter((m) => m.triage?.state === "bubbled_up").map((m) => m.id);
        void (async () => {
          /* The single arm's composition over the set — both halves' inverses off the pre-press
             mirror, so one Undo re-books the booked and re-pins the pinned. */
          const pre = engine.verbRead();
          const inverses = [
            ...inverseMutations(pre, { kind: "mark_seen", messageIds: ids, unread: false }),
            ...booked.flatMap((messageId) =>
              inverseMutations(pre, { kind: "triage_set", messageId, state: "none" })),
          ];
          if (booked.length > 0) {
            const applied = await mutateSetAndReport(
              booked.map((messageId) => ({ kind: "triage_set" as const, messageId, state: "none" as const })),
              () => null,
            );
            if (applied === 0) return;
          }
          if (await markSeen(ids, false)) {
            // The conversation's newest member names the slot — the date its row wears.
            const newest = rows.reduce<string | null>(
              (best, r) => (r.date && (!best || r.date > best) ? r.date : best), null,
            );
            toastWithUndo(t("ohbox.toastResurfaceDone", { when: dayStamp(newest) }), inverses);
          }
        })();
        return true;
      }
      if (action === "later" || action === "aside" || action === "resurface") {
        const state = action === "later" ? "reply_later" : action === "aside" ? "set_aside" : "bubbled_up";
        // The same default the single-message verb uses — the picker's first dated preset, at
        // the account's own hour (mail 0110).
        const when = action === "resurface" ? tomorrowAt(nowAt(), consent.resurfaceTime).iso : null;
        void mutateSetAndReport(
          ids.map((messageId) => ({
            kind: "triage_set" as const,
            messageId,
            state,
            ...(when ? { bubbleUpAt: when } : {}),
          })),
          (applied) => (action === "resurface"
            ? t("ohbox.toastBulkResurface", { count: applied, when: resurfaceLabel(when!) })
            : t(action === "later" ? "ohbox.toastBulkLater" : "ohbox.toastBulkAside", {
                count: applied,
              })),
        );
        return true;
      }
      // A READER MOVES NOTHING, and hears so before anything leaves — asked of EVERY mailbox
      // this selection spans, through the three-state roster. The WHOLE press is refused.
      const refused = readerMoveRefusal(rosterRef.current, mailboxesOf(ids), refusalCopy);
      if (refused !== null) {
        toast(refused);
        return false;
      }
      /**
       * `move:<view>` — THE SAME VERB THE SINGLE ROW USES, once per sender.
       *
       * This arm dispatched a folder move per message against the PRESENTED place, which for a
       * pile is not where the mail sits: Reads and Receipts are what a sender's rule says, so the
       * moves computed no effects and the sentence counted messages nothing had moved. It writes
       * the ROUTING instead — `planMoveToPlace` per sender, narrowed to that sender's picked
       * messages — and names both numbers, because a selection spanning senders changes where
       * mail from every one of them goes from now on.
       */
      const view = action.slice("move:".length) as OhmailView;
      /* The destination has to BE one — the single arm's own guard, asked here too. */
      if (!FOLDER_OF_VIEW[view]) return false;
      const bySender = new Map<string, string[]>();
      const unheld: EngineMutation[] = [];
      for (const id of ids) {
        const m = engine.verbRead().get<EngineMessage>("message", id);
        /* A row neither the mirror nor a page holds is still moved, by id: the server answers. */
        if (!m) {
          unheld.push({ kind: "move", messageId: id, folder: FOLDER_OF_VIEW[view]! });
          continue;
        }
        const key = m.from.address.trim().toLowerCase();
        const held = bySender.get(key);
        if (held) held.push(id);
        else bySender.set(key, [id]);
      }
      const plans = [...bySender.values()]
        .map((picked) => planMoveToPlace(picked[0]!, view, new Set(picked)))
        .filter((x): x is RoutingPressPlan => x !== null);
      const place = PLACE_LABEL[view] ?? view;
      if (plans.length === 0) {
        void mutateSetAndReport(unheld, (applied) => t("ohbox.toastBulkMovedPlain", { count: applied, place }));
        return true;
      }
      for (const mu of unheld) void fileAndRefresh(engine.mutate(mu));
      /* THE GATE'S OWN SENDERS KEEP THE PATH THEY HAVE ALWAYS TAKEN — `fileThroughRouting`'s
         note says why a decision may not be held. A selection mixing the two is not one press
         with two answers: the decided senders are dispatched and awaited as before, and the
         rest ride the window. */
      const decided = plans.filter((p) => decidesAtGate(p.plan));
      const held = plans.filter((p) => !decidesAtGate(p.plan));
      if (decided.length > 0) {
        /* ONE sentence for these, raised when every one of them has answered — and the two
           counts are what APPLIED, never what was picked. A sender whose rule the service
           refused is not a sender whose mail goes there now. */
        void Promise.all(decided.map((p) =>
          dispatchScreeningChange(p.plan, (mu) => fileAndRefresh(engine.mutate(mu)))
            .then((key) => ({ key, moved: p.plan.moved }))))
          .then((answers) => {
            const done = answers.filter((a) => a.key !== "toastRuleFailed");
            const moved = done.reduce((n, a) => n + a.moved, 0);
            toast(done.length === 0
              ? t("ohbox.toastBulkMoveFailed")
              : t("ohbox.toastBulkMovedSenders", { senders: done.length, count: moved, place }));
          });
      }
      if (held.length > 0) {
        /* AND THE REST SPEAK AT THE PRESS, because their rules have not been sent: the counts
           are what this press NAMED, and the window corrects the sentence per sender if the
           server has something to say when it closes. */
        fileThroughRouting({
          plans: held,
          view,
          sentence: t("ohbox.toastBulkMovedSenders", {
            senders: held.length,
            count: held.reduce((n, p) => n + p.plan.moved, 0),
            place,
          }),
          undone: t("screening.toastRoutingUndone"),
        });
      }
      return true;
    },
  );

  /**
   * THE BULK SCREENING PLAN — grouped by SENDER, because that is what screening is about. A screener decision is not
   * a per-message action, and a selection routinely mixes the two cases the single-sender path already distinguishes:
   * a sender still WAITING is decided through `POST /screener/:id`, which promotes a **rule that governs all their
   * future mail**; a sender whose mail has left the Screener is a composition of `move`s with no lasting effect at
   * all. Ten messages from six senders, two of them waiting, is two permanent consent records and four one-off moves
   * — and a naive bulk apply would report "10 messages moved" and never mention the two. So this returns the counts
   * SEPARATELY and the surface states them before committing.
   */

  /**
   * `planScreeningChange` per sender, never a bulk shortcut: forty senders decided through a path that skips
   * `screener_decide` would fork the consent record from the one `screener-service.decide` writes. NOTE THE COUNT
   * THIS DELIBERATELY REPORTS. The plan moves every message the mirror holds from that sender, not only the ones that
   * were picked — that IS what screening a sender means, and it is precisely why the number has to be on screen
   * before the button commits.
   */
  const planBulkScreening = useStableCallback((ids: string[], dest: ScreeningDest) => {
    const seen = new Set<string>();
    const plans: EngineMutation[] = [];
    let senders = 0;
    let messages = 0;
    let rules = 0;
    for (const id of ids) {
      const s = senderScreening(engine.verbRead(), id);
      if (!s || seen.has(s.key)) continue;
      seen.add(s.key);
      /**
       * `makeRule: false`, EXPLICITLY. The single-sender sheet makes a rule by
       * default; bulk does not, and the reason is its own confirm copy — `bulkConfirm`
       * promises *"No rule is made, so future mail is unchanged"* and `bulkConfirmRules`
       * counts only the senders the SCREENER will rule on. Letting the default through here
       * would have made both sentences false for up to forty senders at once, silently, and
       * would have claimed rules whose outcome this path does not await. Owed, not dropped:
       * bulk rule-creation needs its own confirm copy and its own three-outcome reporting.
       */
      const plan = planScreeningChange(s, dest, "sender", false);
      if (plan.mutations.length === 0) continue;
      senders++;
      messages += plan.moved;
      if (plan.rule) rules++;
      plans.push(...plan.mutations);
    }
    return { senders, messages, rules, mutations: plans };
  });

  const onBulkScreen = useStableCallback(
    (ids: string[], dest: ScreeningDest): boolean => {
      /* SCREENING A SET IS FILING IT, so it answers a reader the way every other filing verb
         does — at the press, once, with nothing dispatched and the selection kept. The
         sentence is `readerMoveRefusal`'s, the same one the Move arm, the delete window and
         the Screener's own bar use. The confirm row is BEHIND this: a reader never reaches a
         ceremony whose commit cannot happen. */
      const refused = readerMoveRefusal(rosterRef.current, mailboxesOf(ids), refusalCopy);
      if (refused !== null) {
        toast(refused);
        return false;
      }
      const plan = planBulkScreening(ids, dest);
      const place = PLACE_LABEL[dest] ?? dest;
      if (plan.mutations.length === 0) {
        toast(t("screening.toastBulkNothing", { place }));
        return true;
      }
      // Two sentences because there are two outcomes, and the second one is permanent. The
      // single-sender path already says which happened; this keeps that vocabulary and adds
      // the only thing bulk introduces — that a selection can contain both. Through the set
      // seam: a plan where the service refused everything is a refusal, said once, rather than
      // a count of senders nothing was decided about.
      void mutateSetAndReport(
        plan.mutations,
        () => (plan.rules > 0
          ? t("screening.toastBulkRuled", {
              place,
              senders: plan.senders,
              count: plan.messages,
              rules: plan.rules,
            })
          : t("screening.toastBulkMoved", {
              place,
              senders: plan.senders,
              count: plan.messages,
            })),
      );
      return true;
    },
  );

  /** Tag a whole selection: the shell's picker, pointed at a set. See `pickerIds`. */
  const openBulkTagPicker = useStableCallback((ids: string[], anchor: HTMLElement | null) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
    setPicker({ forId: ids[0]!, ...placePicker(anchor) });
  });

  /**
   * The four callbacks the bulk bar takes, as one stable object.
   *
   * `screenPreview` deliberately drops the mutation list `planBulkScreening` also returns:
   * the confirm row renders on every keystroke of a re-render and must not be able to
   * dispatch anything. Committing is `screen`, which recomputes from the same function — so
   * the numbers on screen and the mutations that run come from one derivation, and a
   * selection that changed between the two cannot commit a plan nobody was shown.
   */
  const bulkVerbs = useMemo(
    () => ({
      run: onBulkAction,
      tag: openBulkTagPicker,
      screenPreview: (ids: string[], dest: ScreeningDest) => {
        const { senders, messages, rules } = planBulkScreening(ids, dest);
        return { senders, messages, rules };
      },
      screen: onBulkScreen,
    }),
    [onBulkAction, openBulkTagPicker, planBulkScreening, onBulkScreen],
  );

  return {
    bulkToggleTag,
    bulkVerbs,
    canDeleteMessage,
    canReplyAllTo,
    changeScreening,
    confirmSubjectRule,
    createTag,
    createTagAlone,
    dropTag,
    lastActed,
    onMessageAction,
    onStageClickCapture,
    onStreamAction,
    openSenderAudit,
    openSenderMenu,
    openSubjectRule,
    openTagPicker,
    retargetRule,
    revokeRule,
    tagAdmin,
    toggleTag,
  };
}
