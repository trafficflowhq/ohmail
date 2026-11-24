/**
 * MOVE, TO A PLACE THE ROUTER OWNS, and all five of Move's destinations are.
 *
 * News is not a folder mail sits in: the partition PRESENTS a message at the place the sender's rule names, so a
 * newsletter shown there is physically in the inbox. So a Move writes the ROUTING, the fact that decides the place,
 * and the row moves with it. Plan and sentence are the Screener's own (`sender-screening.ts`).
 *
 * One plan for both arms: the single row passes the one id it was pressed on, the selection passes one sender's
 * picked ids. A second spelling of "move to a place" is how the row that moves and the rule that is written come to
 * be about different people.
 */
import type { EngineMessage, EngineMutation, OhmailView } from "@ohmail/wire";
import { FOLDER_OF_VIEW, UNDO_CLASS, inverseMutations } from "@ohmail/client-engine";
import { PLACE_LABEL } from "../text/format.js";
import { displayAddress } from "../text/idn.js";
import {
  isOwnSubject,
  planScreeningChange,
  senderScreening,
  splitRoutingPlan,
  type PressMove,
  type ScreeningDest,
  type ScreeningPlan,
} from "./sender-screening.js";
import { planOver, withRow, withRows, type MoveContext } from "./verb-context.js";

/**
 * What a Move press IS, in one shape: the plan, the name the sentence uses, the address the window's journal keeps,
 * and the rows the press named.
 */
export interface RoutingPressPlan {
  plan: ScreeningPlan;
  /** The moves of the rows the press named, beside the plan, which carries none. */
  moves: PressMove[];
  who: string;
  address: string;
  named: string[];
}

/** ONE SENDER'S ROUTING, NARROWED TO THE MESSAGES THIS PRESS NAMED: the plan both Move arms dispatch. */
export function planMoveToPlace(
  cx: MoveContext,
  seedId: string,
  view: OhmailView,
  only: ReadonlySet<string>,
  seed?: EngineMessage,
  gate: "decide" | "leave" = "decide",
): RoutingPressPlan | null {
  /* The verb reader (a History or Search row the mirror does not hold is planned like any other) and the pressed
     row itself, which a reading column can hold past its page. */
  const base = withRows(cx.engine.verbRead(), cx.surfaceById);
  const read = seed ? withRow(base, seed) : base;
  const sender = senderScreening(read, seedId, undefined, undefined, planOver(cx, read));
  if (!sender) return null;
  /* SENDER SCOPE AND NO RETRO: the press is about these messages, not a domain, and nobody asked the server to walk
     the backlog. OUR OWN LETTER TEACHES NOTHING: a rule about our own address is refused at the door and decides
     none of our mail, so it moves with no rule. */
  const own = isOwnSubject(read, seedId, undefined, cx.ownAddresses);
  const planned = planScreeningChange(sender, view as ScreeningDest, "sender", !own, false, gate);
  /* AND IT MOVES THE MESSAGE IT WAS PRESSED ON, not the sender's whole visible backlog: the rule half is kept whole,
     because that IS the routing, and the Screener's decision too, because it re-files the mail it holds itself. */
  const kept = new Set<EngineMutation>([
    ...planned.ruleMutations,
    ...planned.mutations.filter((x) => x.kind === "screener_decide"),
  ]);
  /* THE NAMED MESSAGES ARE MOVED, whatever the plan's own past-mail half decided: with the move as the instruction
     there is no switch to gate on. Only the ids this press names, never the sender's visible backlog. */
  const wanted = FOLDER_OF_VIEW[view];
  const decided = !own && planned.mutations.some((x) => x.kind === "screener_decide");
  const named: PressMove[] = decided
    ? []
    : [...only]
        .map((id) => read.get<EngineMessage>("message", id))
        .filter((msg): msg is EngineMessage => msg != null && wanted != null && msg.folder !== wanted)
        .map((msg) => ({ kind: "move", messageId: msg.id, folder: wanted! }));
  const mutations = planned.mutations.filter((x) => kept.has(x));
  /* The decide re-files the mail it holds itself, so its own count is the plan's to state; otherwise it is what
     this press actually names. */
  const moved = decided ? planned.moved : named.length;
  /* The NAME on the row, and the address only when the row carries no name. */
  const who = sender.name && sender.name.trim() ? sender.name.trim() : displayAddress(sender.address);
  /* Ours decides nothing, our own mail held at the gate included: no rule, no decision. */
  const plan: ScreeningPlan = own
    ? {
        ...planned,
        mutations: [],
        ruleMutations: [],
        ruleState: "none",
        rule: false,
        ruleScope: null,
        retro: false,
        moved,
      }
    : { ...planned, mutations, moved };
  return { plan, moves: named, who, address: sender.address, named: [...only] };
}

/** Whether a plan's routing half carries a Screener decision: see {@link fileThroughRouting}. */
export const decidesAtGate = (plan: ScreeningPlan): boolean =>
  plan.mutations.some((mu) => mu.kind === "screener_decide");

/**
 * ONE ROUTING PRESS: TWO HALVES AND ONE SENTENCE, and every Move arm comes through here. The MAIL moves now through
 * the ordinary filing dispatch, with the engine's own reversal read off the mirror BEFORE it is sent. The ROUTING is
 * HELD for the undo window (`routing-undo.ts`), one intent per SENDER, so a selection spanning six is six intents and
 * ONE report whose Undo takes back all of it.
 *
 * A PLAN CARRYING A SCREENER DECISION NEVER REACHES HERE: the Screener hides a decided sender from its queue through
 * its OWN pending state, so a decision held here would leave that sender pressable at the gate for the length of the
 * window. The callers split those off onto the path they have always taken, with no Undo.
 */
export function fileThroughRouting(
  cx: MoveContext,
  input: {
    plans: readonly RoutingPressPlan[];
    view: OhmailView;
    /** What the press says, in the caller's own vocabulary: one sentence for the whole press. */
    sentence: string;
    /** What Undo says once every held rule has been taken back. */
    undone: string;
  },
): void {
  const { engine, t, toast } = cx;
  const { fileAndRefresh, routing, toastWithUndo } = cx.press;
  const place = PLACE_LABEL[input.view] ?? input.view;
  /* ONE PRE-PRESS READ FOR THE WHOLE PRESS: the inverses name the state this press is about to leave, and a read
     taken after the first dispatch would already describe the new one. */
  const pre = engine.verbRead();
  const inverses: EngineMutation[] = [];
  const subjects: string[] = [];
  let lost = false;
  for (const planned of input.plans) {
    const { mail, routing: rules } = splitRoutingPlan(planned.plan, planned.moves);
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
  /* A JAR THAT REFUSED THE RECORD HAS ALREADY SENT THE RULE, and it refused for the BROWSER, not for this press, so
     the whole sentence says the undo is not on offer rather than offering one over the half that happened to land. */
  if (lost) {
    toast(`${input.sentence} ${t("session.noUndoHere")}`);
    return;
  }
  /* WHETHER A ROUTING PRESS IS UNDOABLE AT ALL IS THE ENGINE'S ANSWER, read from the one table every surface reads
     (`UNDO_CLASS`); this press's own `held` is the second question. */
  if (UNDO_CLASS.routing_plan !== "window" || subjects.length === 0) {
    toastWithUndo(input.sentence, inverses);
    return;
  }
  toastWithUndo(input.sentence, inverses, {
    /* EVERY HELD SENDER, and `true` only if at least one window was still open: a press whose windows have all
       closed took nothing back, and the sentence must not say otherwise. */
    cancel: () => subjects.map((x) => routing.undo(x)).some(Boolean),
    undone: input.undone,
  });
}
