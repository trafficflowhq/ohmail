import type { AccountState, GatedAsk } from "../contract.js";
import type { StorageFigures, StorageModel, StoragePlan, StoragePlanName } from "./model.js";

/**
 * The amounts a picture shows, handed in by whoever draws the states (the states page, from its own fixtures). No
 * amount is written into the app: without them every price is no figure, and every line still stands.
 */
export interface StorageStateAmounts {
  readonly plan: Readonly<Record<StoragePlanName, string>>;
  readonly addon: string;
}

const MILA = "mila@lichtgrat.example";
const HELLO = "hello@milabrunner.example";
const still = (): void => {};
/** The factor's dialog over the pane: the states page fills the slot with the doors' dialog over a fake door. */
const ASKED: GatedAsk = { onVerified: still, onCancel: still, onDiscarded: still };

const row = (id: string, mailbox: string, letters: string, kept: string, expected: string) => ({
  id,
  mailbox,
  letters,
  kept,
  expected,
});

/** The three plans, the person's own and the one that keeps all the mail marked, priced as handed in. */
function plansOf(
  amounts: StorageStateAmounts | null,
  yours: StoragePlanName,
  keepsAll: StoragePlanName | null,
  fit: StoragePlan["fit"] = null,
): NonNullable<StorageFigures["plans"]> {
  const line = (plan: StoragePlanName, room: string, letters: number, mailboxes: number): StoragePlan => ({
    plan,
    room,
    letters,
    mailboxes,
    price: amounts?.plan[plan] ?? null,
    tag: plan === keepsAll ? "keepsAll" : plan === yours ? "yours" : null,
    fit: plan === keepsAll ? fit : null,
  });
  return {
    lines: [
      line("solo", "2 GB", 80_000, 2),
      line("plus", "5 GB", 200_000, 5),
      line("pro", "10 GB", 400_000, 10),
    ],
    addon: { unit: "+10 GB", letters: 400_000, most: 4, price: amounts?.addon ?? null },
    mayChange: true,
  };
}

/** A trial of Plus, two mailboxes, 235 MB of 5 GB: the design's account at rest. */
function trial(amounts: StorageStateAmounts | null): StorageFigures {
  return {
    used: "235 MB",
    limit: "5 GB",
    room: { kind: "trial", limit: "5 GB" },
    tag: null,
    bar: {
      parts: [
        { id: "m1", from: 0, width: 0.0396 },
        { id: "m2", from: 0.0396, width: 0.0074 },
      ],
      rest: null,
      limit: { at: 1, said: "5 GB" },
      plan: null,
      expected: null,
      scale: "5 GB",
    },
    rows: [row("m1", MILA, "7,912", "198 MB", "198 MB"), row("m2", HELLO, "1,494", "37 MB", "37 MB")],
    total: { letters: "9,406", kept: "235 MB", expected: "235 MB" },
    needs: {
      importing: null,
      letters: 9_406,
      size: "235 MB",
      average: { size: "25 KB", measured: true },
      complete: true,
    },
    kept: null,
    plan: { kind: "keeps", limit: "5 GB", plan: "plus" },
    plans: plansOf(amounts, "plus", null),
    mail: true,
  };
}

/** 4.6 GB of 5 GB while a first import still runs: what the mail is expected to need is past the limit. */
function near(amounts: StorageStateAmounts | null): StorageFigures {
  const base = trial(amounts);
  return {
    ...base,
    used: "4.6 GB",
    tag: { kind: "percent", percent: 92 },
    bar: {
      parts: [
        { id: "m1", from: 0, width: 0.623 },
        { id: "m2", from: 0.623, width: 0.1295 },
      ],
      rest: { kind: "toCome", from: 0.7525, width: 0.2475 },
      limit: { at: 0.8197, said: "5 GB" },
      plan: null,
      expected: { at: 1, said: "6.1 GB" },
      scale: "6.1 GB",
    },
    rows: [row("m1", MILA, "201,000", "3.8 GB", "5 GB"), row("m2", HELLO, "43,000", "790 MB", "1.1 GB")],
    total: { letters: "244,000", kept: "4.6 GB", expected: "6.1 GB" },
    needs: { ...base.needs!, importing: { stored: 184_000 }, letters: 244_000, size: "6.1 GB" },
    plans: plansOf(amounts, "plus", "pro"),
  };
}

/** At the limit: the oldest letters' text stays on the mail server, from a month on. */
function full(amounts: StorageStateAmounts | null): StorageFigures {
  const base = near(amounts);
  return {
    ...base,
    used: "5 GB",
    tag: { kind: "full" },
    bar: { ...base.bar, rest: { kind: "onServer", from: 0.8197, width: 0.1803 } },
    rows: [row("m1", MILA, "201,000", "4.1 GB", "5 GB"), row("m2", HELLO, "43,000", "920 MB", "1.1 GB")],
    total: { letters: "244,000", kept: "5 GB", expected: "6.1 GB" },
    needs: { ...base.needs!, importing: null },
    kept: { kind: "from", month: "March 2021", refills: true },
  };
}

/** A paid account above its plan's lower limit, the higher one kept until a day. */
function held(amounts: StorageStateAmounts | null, until: string | null): StorageFigures {
  const base = trial(amounts);
  return {
    ...base,
    used: "3.4 GB",
    room: until === null ? { kind: "plan", limit: "5 GB" } : { kind: "held", limit: "5 GB", until },
    bar: {
      ...base.bar,
      parts: [
        { id: "m1", from: 0, width: 0.58 },
        { id: "m2", from: 0.58, width: 0.102 },
      ],
      plan: { at: 0.4, said: "2 GB" },
    },
    rows: [row("m1", MILA, "115,600", "2.9 GB", "2.9 GB"), row("m2", HELLO, "20,400", "510 MB", "510 MB")],
    total: { letters: "136,000", kept: "3.4 GB", expected: "3.4 GB" },
    needs: { ...base.needs!, letters: 136_000, size: "3.4 GB" },
    plan:
      until === null
        ? { kind: "keeps", limit: "5 GB", plan: "solo" }
        : { kind: "until", limit: "5 GB", cap: "2 GB", date: until },
    plans: plansOf(amounts, "solo", "plus"),
  };
}

const at = (address: string | null, figures: StorageFigures, over: Partial<StorageModel> = {}) =>
  ({
    address,
    model: {
      figures,
      mail: { on: figures.mail, busy: false, failed: false },
      changing: false,
      refusal: null,
      nothingRan: false,
      ask: null,
      change: still,
      setMail: still,
      ...over,
    },
  }) as const satisfies AccountState<StorageModel>;

/**
 * The pane's states where the build links out, each with its address in the comparison's registry, or `null` where
 * no picture draws it: a change on its way, waiting for the factor or refused, a factor after Cancel, a write on its
 * way. `info` draws what rest draws: the kit has no card behind the info mark yet, and the pane says what counts and
 * why on its sheets (FOR THE KIT, in the share's notes).
 */
export function storageStates(amounts: StorageStateAmounts | null = null) {
  const rest = trial(amounts);
  const trialRoom: StorageFigures = {
    ...rest,
    room: { kind: "trial", limit: "5 GB" },
    bar: { ...rest.bar, plan: { at: 0.4, said: "2 GB" } },
    plan: { kind: "trial", limit: "5 GB", cap: "2 GB" },
    plans: plansOf(amounts, "solo", null),
  };
  const atLimit = full(amounts);
  return {
    rest: at("screen=settings&sec=storage", rest),
    info: at("screen=settings&sec=storage&state=info", rest),
    near: at("screen=settings&sec=storage&state=near", near(amounts)),
    full: at("screen=settings&sec=storage&state=full", atLimit),
    trialRoom: at("keeps=trialroom&screen=settings&sec=storage", trialRoom),
    heldUntil: at("keeps=drop&screen=settings&sec=storage&state=held", held(amounts, "November 26, 2026")),
    heldUndated: at("keeps=droppaid&screen=settings&sec=storage&state=held", held(amounts, null)),
    incomplete: at("keeps=incomplete&screen=settings&sec=storage", {
      ...rest,
      needs: { ...rest.needs!, complete: false },
    }),
    measured: at("keeps=avg&screen=settings&sec=storage", rest),
    unmeasured: at("keeps=avgdefault&screen=settings&sec=storage", {
      ...rest,
      needs: { ...rest.needs!, average: { size: "25 KB", measured: false } },
    }),
    keptSome: at("keeps=keptsome&screen=settings&sec=storage&state=full", {
      ...atLimit,
      kept: { kind: "some", count: 312, refills: true },
    }),
    mailRefused: at("keeps=mailfailed&screen=settings&sec=storage", rest, {
      mail: { on: true, busy: false, failed: true },
    }),
    mailWriting: at(null, rest, { mail: { on: false, busy: true, failed: false } }),
    changing: at(null, rest, { changing: true }),
    asked: at(null, rest, { changing: true, ask: ASKED }),
    refused: at(null, rest, { refusal: { word: "failed" } }),
    refusedAgain: at(null, rest, { refusal: { word: "sign_in" } }),
    unverified: at(null, rest, { refusal: { word: "unverified" } }),
    nothingRan: at(null, rest, { nothingRan: true }),
    noBlock: at(null, rest, { figures: null }),
  };
}

/** The states of a build that may not link out: the same facts, with no figure and no verb. */
export function storageFactsStates() {
  return { near: at("screen=settings&sec=storage&state=near&store=1", near(null)) };
}
