import type {
  EngineMessage,
  EngineMutation,
  RuleEntity as RuleDTO,
  ScreenerWaitingWire,
} from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OUTBOX_TYPE,
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
 * A SCREENED-OUT SENDER NEVER REACHES THE OHBOX, WHATEVER DOOR THE DECISION WENT THROUGH.
 *
 * Seen on the desktop's Cloud mirror during a first sync (2026-10-01): the press went through
 * the sidecar, whose own pull was still paging, so the drain after the confirm carried no rule. The overlay's rule retired at the settle, the queue page (read from the account live)
 * stopped listing the sender, and their mail presented in the Ohbox until the sidecar caught up.
 * One arm per door shape; the adapter's real decide parsing runs inside the engine.
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
const SERVER_RULE = rule({});
/** An allow rule written while the sender's mail waited at the gate — the decide's twin. */
const TWIN = rule({ id: "twin-1", destination: "INBOX", provenance: "manual", createdAt: ago(2), updatedAt: ago(2) });

const LISTED: ScreenerWaitingWire = {
  items: [{ messageId: "held", address: SPAM, name: null, receivedAt: ago(1), subject: "s", snippet: "s", mailboxId: "mb" }],
  nextCursor: null, total: 1, inFlight: [],
};
const EMPTY: ScreenerWaitingWire = { items: [], nextCursor: null, total: 0, inFlight: [] };

interface DoorShape {
  /** Does the door's `/sync` carry the decision once the POST has been answered? */
  carries: boolean;
  /** `local-head`: a relaying door whose echo wait was cut re-stamps its own head; `account`: the server's own. */
  seq: "local-head" | "account" | "none";
  /** `dto`: the 200 carries the rules it wrote; `id-only`: an older server names the created id alone; `bare`: no id at all. */
  body: "dto" | "id-only" | "bare";
  twin?: boolean;
}

const create = (type: string, id: string, seq: number, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq, updatedAt: NOW.toISOString(), entity }) as SyncChange;

async function door(shape: DoorShape, store: MirrorStore = new MemoryMirrorStore()) {
  let decided = false;
  let served = false;
  let carried = false;
  let listing: ScreenerWaitingWire | null = null;
  const pending: SyncChange[][] = [];
  const twinNow = { ...TWIN, destination: "ohmail/Screened" as const, updatedAt: NOW.toISOString() };
  const sync = async (): Promise<SyncResponse> => {
    let changes: SyncChange[] = [];
    if (!served) {
      served = true;
      changes = [
        create("mailbox", "mb", 1, { id: "mb", address: OWN }),
        create("message", HELD.id, 2, HELD),
        create("message", INBOXED.id, 3, INBOXED),
        ...(shape.twin ? [create("rule", TWIN.id, 4, TWIN)] : []),
      ];
    } else if (decided && shape.carries && !carried) {
      carried = true;
      // One rule per key (`applyScreenerDecision`): a sender with a rule has THAT rule rewritten,
      // and only a sender with none gets the promoted one.
      changes = [
        ...(shape.twin ? [{ ...create("rule", TWIN.id, 11, twinNow), op: "update" } as SyncChange]
          : [create("rule", SERVER_RULE.id, 10, SERVER_RULE)]),
        { type: "message", op: "move", id: HELD.id, seq: 12, updatedAt: NOW.toISOString(),
          entity: { ...HELD, folder: "ohmail/Screened", unread: false }, move: { from: "ohmail/Screener", to: "ohmail/Screened" } } as SyncChange,
      ];
    }
    changes.push(...(pending.shift() ?? []));
    return { changes: { creates: changes, updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() };
  };
  const posts: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    decided = true;
    const body = {
      messageId: HELD.id, appliedFolder: "ohmail/Screened",
      ...(shape.body === "bare" ? {} : { createdRuleId: shape.twin ? TWIN.id : SERVER_RULE.id }),
      mailboxes: { filed: ["mb"], requested: [] },
      ...(shape.body === "dto" ? { createdRule: shape.twin ? twinNow : SERVER_RULE, retargetedRules: [] } : {}),
    };
    // `next_seq` names the LAST seq a store allocated, so a re-stamped head can equal a held row's.
    const seq = shape.seq === "local-head" ? (shape.twin ? "4" : "3") : shape.seq === "account" ? "12" : null;
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json", ...(seq === null ? {} : { "x-sync-seq": seq }) },
    });
  }) as unknown as typeof globalThis.fetch;
  const http = new HttpAdapter({ baseUrl: "https://door.test", fetch: fetchImpl });
  const adapter = {
    sync,
    mutate: (m: EngineMutation, o: { idempotencyKey: string }) => http.mutate(m, o),
    fetchBody: async () => null,
    screenerWaiting: async () => listing ?? (decided ? EMPTY : LISTED),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store, now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.refreshScreenerWaiting();
  return {
    engine, store, posts,
    /** Queue one more page for the door's next drain. */
    push: (...changes: SyncChange[]) => pending.push(changes),
    /** What the account's queue answers from now on. */
    list: (w: ScreenerWaitingWire) => { listing = w; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function placed(engine: OhmailEngine) {
  const raw = engine.read();
  const part = consentPartition(raw, { now: NOW, ownAddresses: [OWN] });
  const box = ohboxView(presentationReader(raw, part));
  const ohbox = [...box.resurfaced, ...box.newForYou, ...box.previouslySeen]
    .filter((m) => m.from.address === SPAM).map((m) => m.id);
  return { ohbox, held: part.placeOf.get(HELD.id), inboxed: part.placeOf.get(INBOXED.id) };
}

const screenOut: EngineMutation = { kind: "screener_decide", senderId: HELD.id, decision: "no", dest: "screened", scope: "sender" };

/** The press, then every sample the person could see: the confirm and four drains past the shadow's bound. */
async function pressAndSample(engine: OhmailEngine): Promise<Array<ReturnType<typeof placed>>> {
  const res = await engine.mutate(screenOut);
  expect(res.status).toBe("confirmed");
  await flush();
  const samples = [placed(engine)];
  for (let i = 0; i < 4; i++) {
    await engine.syncOnce();
    await flush();
    samples.push(placed(engine));
  }
  return samples;
}

const ON_THE_SHELF = { ohbox: [], held: "ohmail/Screened", inboxed: "ohmail/Screened" };

describe("before the press the state is right (the control every arm stands on)", () => {
  it("a listed sender's gate mail and INBOX mail present at the gate, none in the Ohbox", async () => {
    const { engine } = await door({ carries: false, seq: "local-head", body: "dto" });
    expect(placed(engine)).toEqual({ ohbox: [], held: "ohmail/Screener", inboxed: "ohmail/Screener" });
  });
});

describe("a relaying door whose echo wait was cut (the desktop's Cloud mirror during first sync)", () => {
  it("this server's confirm carries the rule: the sender's mail is on the shelf at every sample", async () => {
    const { engine } = await door({ carries: false, seq: "local-head", body: "dto" });
    for (const [i, s] of (await pressAndSample(engine)).entries()) expect(s, `sample ${i}`).toEqual(ON_THE_SHELF);
  });

  it("an older server names only the rule's id: the window keeps the decision until the copy has it", async () => {
    const { engine } = await door({ carries: false, seq: "local-head", body: "id-only" });
    for (const [i, s] of (await pressAndSample(engine)).entries()) expect(s, `sample ${i}`).toEqual(ON_THE_SHELF);
  });

  it("the sender's own rule the decide rewrote stays rewritten past the shadow's bound", async () => {
    for (const body of ["dto", "id-only"] as const) {
      const { engine } = await door({ carries: false, seq: "local-head", body, twin: true });
      expect(placed(engine).ohbox, `${body}: the allow twin presents the INBOX mail before the press`).toEqual([INBOXED.id]);
      for (const [i, s] of (await pressAndSample(engine)).entries()) expect(s, `${body} sample ${i}`).toEqual(ON_THE_SHELF);
    }
  });
});

describe("a lagging door that strips the seq (no echo can be applied)", () => {
  it("the window keeps the decision until the copy has it", async () => {
    const { engine } = await door({ carries: false, seq: "none", body: "dto" });
    for (const [i, s] of (await pressAndSample(engine)).entries()) expect(s, `sample ${i}`).toEqual(ON_THE_SHELF);
  });
});

describe("doors whose drain carries the decision (controls: green before and after)", () => {
  it("the direct door (the web, the phone on Cloud): the confirm still drains, and the held mail's move is in the copy", async () => {
    const { engine, store } = await door({ carries: true, seq: "account", body: "dto" });
    expect((await engine.mutate(screenOut)).status).toBe("confirmed");
    // Read before any further drain: the echo carries the rules, and only the confirm's own drain the moves.
    expect(store.get<EngineMessage>("message", HELD.id)?.folder, "the drain after the confirm did not run").toBe("ohmail/Screened");
    expect(store.get<RuleDTO>("rule", SERVER_RULE.id)?.destination).toBe("ohmail/Screened");
    await flush();
    expect(placed(engine)).toEqual(ON_THE_SHELF);
    for (let i = 0; i < 4; i++) {
      await engine.syncOnce();
      expect(placed(engine), `drain ${i}`).toEqual(ON_THE_SHELF);
    }
  });

  it("a relaying door whose echo was covered answers no seq, and its drain carries the rule", async () => {
    const { engine } = await door({ carries: true, seq: "none", body: "dto" });
    for (const [i, s] of (await pressAndSample(engine)).entries()) expect(s, `sample ${i}`).toEqual(ON_THE_SHELF);
  });

  it("the same flow through the sender sheet's rule press already echoes its rule", async () => {
    const { engine } = await door({ carries: false, seq: "local-head", body: "dto" });
    const fetchRule = (async () => new Response(JSON.stringify(SERVER_RULE), {
      status: 201, headers: { "content-type": "application/json", "x-sync-seq": "4" },
    })) as unknown as typeof globalThis.fetch;
    const outcome = await new HttpAdapter({ baseUrl: "https://door.test", fetch: fetchRule }).mutate(
      { kind: "rule_create", ruleKind: "sender", match: SPAM, destination: "ohmail/Screened", applyRetro: true },
      { idempotencyKey: "k" },
    );
    expect(outcome.changes.map((c) => [c.type, c.op, c.id])).toEqual([["rule", "create", SERVER_RULE.id]]);
    void engine;
  });
});

describe("what retires a decision the window kept (an older server, a lagging door)", () => {
  it("the queue lists the sender again after the confirm: the copy is the truth again", async () => {
    const { engine, list } = await door({ carries: false, seq: "local-head", body: "id-only" });
    await pressAndSample(engine);
    list(LISTED);
    await engine.refreshScreenerWaiting();
    expect(placed(engine), "a kept decision outlived the server reopening the question").toEqual(
      { ohbox: [], held: "ohmail/Screener", inboxed: "ohmail/Screener" });
  });

  it("the copy takes in the server's rule: the kept decision is gone, so a later delete is seen", async () => {
    const { engine, push } = await door({ carries: false, seq: "local-head", body: "id-only" });
    await pressAndSample(engine);
    push(create("rule", SERVER_RULE.id, 20, SERVER_RULE));
    await engine.syncOnce();
    expect(placed(engine)).toEqual(ON_THE_SHELF);
    push({ type: "rule", op: "delete", id: SERVER_RULE.id, seq: 21, updatedAt: NOW.toISOString() } as SyncChange);
    await engine.syncOnce();
    expect(placed(engine).inboxed, "the kept decision masked the copy after the copy held the rule").toBe("INBOX");
  });

  it("the copy takes in a later word on the rule (another device admitted the sender): the copy wins", async () => {
    const { engine, push } = await door({ carries: false, seq: "local-head", body: "id-only" });
    await pressAndSample(engine);
    push(create("rule", SERVER_RULE.id, 20, { ...SERVER_RULE, destination: "INBOX" }));
    await engine.syncOnce();
    expect(placed(engine).inboxed, "the kept decision masked a later word the copy holds").toBe("INBOX");
  });

  it("the copy takes in the rule's delete before it ever held the rule: the copy wins", async () => {
    const { engine, push } = await door({ carries: false, seq: "local-head", body: "id-only" });
    await pressAndSample(engine);
    push({ type: "rule", op: "delete", id: SERVER_RULE.id, seq: 20, updatedAt: NOW.toISOString() } as SyncChange);
    await engine.syncOnce();
    expect(placed(engine).inboxed, "the kept decision outlived a delete the copy holds").toBe("INBOX");
  });

  it("a server that names no rule id: the kept rule yields once the copy holds the subject's rule", async () => {
    const { engine, push } = await door({ carries: false, seq: "local-head", body: "bare" });
    for (const [i, s] of (await pressAndSample(engine)).entries()) expect(s, `sample ${i}`).toEqual(ON_THE_SHELF);
    push(create("rule", SERVER_RULE.id, 20, SERVER_RULE));
    await engine.syncOnce();
    push({ type: "rule", op: "delete", id: SERVER_RULE.id, seq: 21, updatedAt: NOW.toISOString() } as SyncChange);
    await engine.syncOnce();
    expect(placed(engine).inboxed, "the kept rule outlived the copy taking in the subject's own rule").toBe("INBOX");
  });

  it("a newer verb on the subject supersedes it", async () => {
    const { engine } = await door({ carries: false, seq: "local-head", body: "id-only" });
    await pressAndSample(engine);
    // The rules list shows the kept rule under the server's id, so the person's next word names it.
    const deleted = await engine.mutate({ kind: "rule_delete", ruleId: SERVER_RULE.id });
    expect(deleted.status).not.toBe("rolled_back");
    await flush();
    expect(placed(engine).inboxed, "the kept decision outlived the person's own later word").toBe("INBOX");
  });

  it("nothing outlives a restart: the outbox holds no entry for the decision", async () => {
    const store = new MemoryMirrorStore();
    const { engine } = await door({ carries: false, seq: "local-head", body: "id-only" }, store);
    await pressAndSample(engine);
    expect(engine.pendingMutations(), "the decision is still queued").toEqual([]);
    expect(store.entries(OUTBOX_TYPE), "the decision outlived its confirm in the outbox").toEqual([]);
  });
});
