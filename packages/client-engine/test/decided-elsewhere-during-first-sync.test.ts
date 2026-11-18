import type {
  EngineMessage,
  EngineMutation,
  RuleEntity as RuleDTO,
  ScreenerWaitingWire,
} from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  CursorExpiredError,
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  ohboxView,
  presentationReader,
  type EngineAdapter,
  type MirrorStore,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * A SENDER DECIDED ON ANOTHER DEVICE STAYS OUT OF THIS DEVICE'S OHBOX WHILE ITS COPY CATCHES UP.
 *
 * The desktop's copy is a mirror still replaying the account during its first sync. The queue it
 * reads relays live from the account, so it stops listing a sender screened out on the phone long
 * before the replay brings the rule. Such an answer says `copyBehind`, and the sender's held mail
 * then stays at the gate until the mirror's rules pass lands the rule. The three cases below name the three
 * ways the decision was seen lost before this held.
 */

const NOW = new Date("2026-10-01T09:00:00.000Z");
const OWN = "me@home.test";
const SPAM = "offers@spam.test";
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function msg(id: string, over: Partial<EngineMessage>): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: SPAM }, to: [], cc: [],
    date: ago(1), folder: "INBOX", snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ago(1), ...over,
  };
}

const HELD = msg("held", { folder: "ohmail/Screener", date: ago(1) });
const INBOXED = msg("inboxed", { folder: "INBOX", date: ago(3) });

const rule = (over: Partial<RuleDTO>): RuleDTO => ({
  id: "srv-rule", kind: "sender", match: SPAM, destination: "ohmail/Screened", priority: 0,
  provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  retro: { requestedAt: NOW.toISOString(), doneAt: null }, byOhmail: false, ...over,
});
const DENY = rule({});
const ALLOW = rule({ id: "srv-allow", destination: "INBOX" });

const LISTED: ScreenerWaitingWire = {
  items: [{ messageId: "held", address: SPAM, name: null, receivedAt: ago(1), subject: "s", snippet: "s", mailboxId: "mb" }],
  nextCursor: null, total: 1, inFlight: [],
};
const EMPTY: ScreenerWaitingWire = { items: [], nextCursor: null, total: 0, inFlight: [] };

const create = (type: string, id: string, seq: number, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq, updatedAt: NOW.toISOString(), entity }) as SyncChange;

/**
 * `behind`: the door's copy is still taking in the account, and its queue answers say so — the
 * sidecar's own decoration while it bootstraps. `false` is the direct door (the web, the phone).
 */
async function door(o: { behind: boolean; body?: "dto" | "id-only" }) {
  let behind = o.behind;
  let decided = false;
  let asks = 0;
  let hold: Promise<void> | null = null;
  let served = false;
  let expireNext = false;
  let listing: ScreenerWaitingWire = LISTED;
  const pending: SyncChange[][] = [];
  const sync = async (): Promise<SyncResponse> => {
    if (expireNext) { expireNext = false; served = false; throw new CursorExpiredError(); }
    let changes: SyncChange[] = [];
    if (!served) {
      served = true;
      changes = [
        create("mailbox", "mb", 1, { id: "mb", address: OWN }),
        create("message", HELD.id, 2, HELD),
        create("message", INBOXED.id, 3, INBOXED),
      ];
    }
    changes.push(...(pending.shift() ?? []));
    return { changes: { creates: changes, updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() };
  };
  const fetchImpl = (async () => {
    decided = true;
    const body = {
      messageId: HELD.id, appliedFolder: "ohmail/Screened", createdRuleId: DENY.id, mailboxes: { filed: ["mb"], requested: [] },
      ...(o.body === "id-only" ? {} : { createdRule: DENY, retargetedRules: [] }),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-sync-seq": "3" } });
  }) as unknown as typeof globalThis.fetch;
  const http = new HttpAdapter({ baseUrl: "https://door.test", fetch: fetchImpl });
  const adapter = {
    sync,
    mutate: (m: EngineMutation, opts: { idempotencyKey: string }) => http.mutate(m, opts),
    fetchBody: async () => null,
    screenerWaiting: async () => {
      asks += 1;
      if (hold) await hold;
      return { ...(decided ? EMPTY : listing), ...(behind ? { copyBehind: true as const } : {}) };
    },
  } as unknown as EngineAdapter;
  const boot = async (store: MirrorStore) => {
    const e = new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: { mode: "full" } });
    await e.start();
    await e.refreshScreenerWaiting();
    return e;
  };
  const engine = await boot(new MemoryMirrorStore());
  return {
    engine,
    /** Another device decides: the account's queue stops listing the sender. */
    decidedElsewhere: () => { listing = EMPTY; },
    /** The mirror's rules pass (or its replay) brings these to the copy at the next drain. */
    land: (...changes: SyncChange[]) => pending.push(changes),
    /** The copy has taken in the account: its queue answers stop saying it is behind. */
    caughtUp: () => { behind = false; },
    expire: () => { expireNext = true; },
    /** How many times this window has asked the queue. */
    asks: () => asks,
    /** Keep the queue's answers in the air until the returned release is called. */
    holdAnswers: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => { release = r; });
      return () => { hold = null; release(); };
    },
    relaunch: async () => { served = false; return boot(new MemoryMirrorStore()); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function placed(engine: OhmailEngine) {
  const raw = engine.read();
  const part = consentPartition(raw, { now: NOW, ownAddresses: [OWN] });
  const box = ohboxView(presentationReader(raw, part));
  const ohbox = [...box.resurfaced, ...box.newForYou, ...box.previouslySeen]
    .filter((m) => m.from.address === SPAM).map((m) => m.id).sort();
  return { ohbox, held: part.placeOf.get(HELD.id), inboxed: part.placeOf.get(INBOXED.id) };
}

/** The queue answered after the other device's decision, then four drains: every sample a person sees. */
async function afterTheAnswer(engine: OhmailEngine): Promise<Array<ReturnType<typeof placed>>> {
  await engine.refreshScreenerWaiting();
  const samples = [placed(engine)];
  for (let i = 0; i < 4; i++) {
    await engine.syncOnce();
    await flush();
    samples.push(placed(engine));
  }
  return samples;
}

const AT_THE_GATE = { ohbox: [], held: "ohmail/Screener", inboxed: "ohmail/Screener" };
const ON_THE_SHELF = { ohbox: [], held: "ohmail/Screened", inboxed: "ohmail/Screened" };

describe("screened out on another device while this copy is behind", () => {
  it("the sender's held and INBOX mail stay at the gate at every sample, then file once the rule lands", async () => {
    const d = await door({ behind: true });
    expect(placed(d.engine), "before the decision the sender waits at the gate").toEqual(AT_THE_GATE);
    d.decidedElsewhere();
    for (const [i, s] of (await afterTheAnswer(d.engine)).entries()) expect(s, `sample ${i}`).toEqual(AT_THE_GATE);
    d.land(create("rule", DENY.id, 20, DENY));
    await d.engine.syncOnce();
    expect(placed(d.engine), "the rule landed and the mail did not file").toEqual(ON_THE_SHELF);
  });

  it("CONTROL: the direct door's answer is the account's own, and an unlisted sender is released as before", async () => {
    const d = await door({ behind: false });
    d.decidedElsewhere();
    await d.engine.refreshScreenerWaiting();
    expect(placed(d.engine).ohbox).toEqual(["held", "inboxed"]);
  });
});

describe("allowed on another device while this copy is behind (control)", () => {
  it("is held at the gate, then released: the INBOX mail with its rule, the held mail with its move", async () => {
    const d = await door({ behind: true });
    d.decidedElsewhere();
    for (const [i, s] of (await afterTheAnswer(d.engine)).entries()) expect(s, `sample ${i}`).toEqual(AT_THE_GATE);
    d.land(create("rule", ALLOW.id, 20, ALLOW));
    await d.engine.syncOnce();
    expect(placed(d.engine), "the allow rule landed and the INBOX mail was not released").toEqual(
      { ohbox: ["inboxed"], held: "ohmail/Screener", inboxed: "INBOX" });
    d.land({ type: "message", op: "move", id: HELD.id, seq: 21, updatedAt: NOW.toISOString(),
      entity: { ...HELD, folder: "INBOX" }, move: { from: "ohmail/Screener", to: "INBOX" } } as SyncChange);
    await d.engine.syncOnce();
    expect(placed(d.engine).ohbox, "the held mail's move landed and it was not released").toEqual(["held", "inboxed"]);
  });

  it("admitted with no rule (a correspondent): released once the copy has caught up and this window has drained", async () => {
    const d = await door({ behind: true });
    d.decidedElsewhere();
    await d.engine.refreshScreenerWaiting();
    expect(placed(d.engine)).toEqual(AT_THE_GATE);
    d.caughtUp();
    await d.engine.refreshScreenerWaiting();
    expect(placed(d.engine), "released before this window drained past the catch-up").toEqual(AT_THE_GATE);
    await d.engine.syncOnce();
    await flush();
    expect(placed(d.engine).ohbox, "the copy caught up and the admitted sender stayed held").toEqual(["held", "inboxed"]);
  });
});

const RELEASED = { ohbox: ["held", "inboxed"], held: "INBOX", inboxed: "INBOX" };

describe("the hold ends once this window has drained past the copy's catch-up", () => {
  const other = (id: string, seq: number, folder: string) => create("message", id, seq,
    msg(id, { from: { name: null, address: "friend@else.test" }, folder: folder as EngineMessage["folder"], date: ago(0.5) }));

  it("caught up, then a drain with nothing and one with a non-gate letter: released at the second", async () => {
    const d = await door({ behind: true });
    d.decidedElsewhere();
    await d.engine.refreshScreenerWaiting();
    expect(placed(d.engine)).toEqual(AT_THE_GATE);
    d.caughtUp();
    await d.engine.syncOnce(); await flush();
    expect(placed(d.engine), "released before a drain begun after the catch-up had settled").toEqual(AT_THE_GATE);
    d.land(other("o1", 30, "INBOX"));
    await d.engine.syncOnce(); await flush(); await flush();
    expect(placed(d.engine), "the hold outlived the catch-up").toEqual(RELEASED);
    d.land(other("o2", 31, "ohmail/Screener"));
    await d.engine.syncOnce(); await flush(); await flush();
    expect(placed(d.engine)).toEqual(RELEASED);
  });

  it("a rule the copy took in as it caught up files the mail, and nothing reaches the Ohbox on the way", async () => {
    const d = await door({ behind: true });
    d.decidedElsewhere();
    await d.engine.refreshScreenerWaiting();
    d.land(create("rule", DENY.id, 20, DENY));
    d.caughtUp();
    await d.engine.refreshScreenerWaiting();
    expect(placed(d.engine), "released ahead of the rule this window had not drained").toEqual(AT_THE_GATE);
    await d.engine.syncOnce(); await flush(); await flush();
    expect(placed(d.engine), "the rule landed and the mail did not file").toEqual(ON_THE_SHELF);
  });

  it("an ask already in the air is not asked again by a settle while the copy is behind", async () => {
    const d = await door({ behind: true });
    const before = d.asks();
    const release = d.holdAnswers();
    const pending = d.engine.refreshScreenerWaiting();
    await d.engine.syncOnce(); await flush();
    expect(d.asks() - before, "the settle asked over an answer in the air").toBe(1);
    release();
    await pending;
    await d.engine.syncOnce(); await flush();
    expect(d.asks() - before, "a settle while the copy is behind did not ask").toBe(2);
  });

  it("CONTROL: a door that never says its copy is behind is asked no more often", async () => {
    const d = await door({ behind: false });
    const before = d.asks();
    for (let i = 0; i < 3; i++) { await d.engine.syncOnce(); await flush(); }
    expect(d.asks() - before).toBe(0);
  });
});

describe("this device's own press, when its copy is rebuilt mid-sync", () => {
  const screenOut: EngineMutation = { kind: "screener_decide", senderId: HELD.id, decision: "no", dest: "screened", scope: "sender" };
  /** The press as it was measured: the confirm, then four drains past the shadow's bound. */
  const press = async (engine: OhmailEngine) => {
    expect((await engine.mutate(screenOut)).status).toBe("confirmed");
    await flush();
    for (let i = 0; i < 4; i++) { await engine.syncOnce(); await flush(); }
  };

  for (const body of ["dto", "id-only"] as const) {
    it(`a re-bootstrap of the window keeps the sender off the Ohbox (${body})`, async () => {
      const d = await door({ behind: true, body });
      await press(d.engine);
      d.expire();
      await d.engine.syncOnce().catch(() => {});
      await d.engine.syncOnce().catch(() => {});
      await d.engine.refreshScreenerWaiting();
      await flush();
      expect(placed(d.engine).ohbox, "the decision was lost with the window's store").toEqual([]);
    });
  }

  it("a relaunched window keeps the sender off the Ohbox", async () => {
    const d = await door({ behind: true });
    await press(d.engine);
    const again = await d.relaunch();
    await again.syncOnce();
    expect(placed(again).ohbox, "the relaunch lost the decision").toEqual([]);
  });
});

describe("the queue wire carries the door's word that its copy is behind", () => {
  async function asked(body: Record<string, unknown>) {
    const fetchImpl = (async () => new Response(JSON.stringify({ items: [], nextCursor: null, total: 0, ...body }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
    return await new HttpAdapter({ baseUrl: "https://door.test", fetch: fetchImpl }).screenerWaiting({ limit: 200 });
  }

  it("reads `copyBehind: true` and nothing else as the flag", async () => {
    expect((await asked({ copyBehind: true })).copyBehind).toBe(true);
    for (const v of [false, "yes", 1, null]) expect("copyBehind" in (await asked({ copyBehind: v })), String(v)).toBe(false);
    expect("copyBehind" in (await asked({}))).toBe(false);
  });
});
