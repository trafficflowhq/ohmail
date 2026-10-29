/**
 * SEND + DONE ON THE PHONE — the composer's second send action, driven through the SAME
 * `bootEngine` composition the app runs, against the loopback mail server.
 *
 * What bites:
 *  · the action is OFFERED by the engine's one rule and by nothing local — a source in the
 *    Ohbox offers it, a message already finished does not;
 *  · the release runs ONLY after the engine accepted the send: an armed refusal on
 *    `POST /drafts/:id/send` leaves the source exactly as it was and says the send's own
 *    sentence, with no `mark_seen` anywhere on the wire;
 *  · an accepted send files the source and the pill says ONE thing — "Sent · marked done",
 *    not "Reply sent." followed by it;
 *  · a forward takes the same action through the same rule;
 *  · the door is the ACTIONS layer, which the paired and the standalone doors share: nothing
 *    here reads `standalone`, unlike Send later, whose own predicate does.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { resurfacedThreads, type EngineMessage, type EntityReader, type MutationResult, type SendAndDonePlan } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { flushQueued, liveActions, type LiveWorldActions } from "../src/state/live";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined, triage?: string) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", {
    subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" }, ...(triage ? { triage: { state: triage } } : {}),
  }));
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const mutations: Record<string, unknown>[] = [];
  const undos: Array<() => void> = [];
  const engine = new Proxy(boot.engine, {
    get(target, prop) {
      if (prop === "mutate") {
        return (m: Record<string, unknown>, o?: unknown) => {
          mutations.push(m);
          return (target.mutate as (a: unknown, b?: unknown) => unknown)(m, o);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const actions: LiveWorldActions = liveActions({
    engine,
    toast: (m, opts) => { toasts.push(sayArg(m)); if (opts?.undo) undos.push(opts.undo); },
    uuid,
    zone: "UTC",
  });
  return { fake, origin, ...boot, actions, toasts, mutations, undos };
}

/** `mark_seen` requests the SERVER received — the release as the wire saw it, whatever engine sent it. */
const wireMarks = (fake: ReturnType<typeof mailServer>): number =>
  fake.seen.filter((r) => r.method === "PATCH" && r.url === "/messages").length;
/** The send route answers 500 to the next `n` sends — a counted, retryable failure. */
const failSends = (fake: ReturnType<typeof mailServer>, n: number): void => {
  for (let i = 0; i < n; i++) fake.failNextStatus("POST", "/drafts/", 500);
};

const reads = (mutations: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
  mutations.filter((m) => m.kind === "mark_seen");
const unreadOf = (live: { engine: { read: () => { get: <T>(t: string, id: string) => T | undefined } } }, id: string): boolean | undefined =>
  live.engine.read().get<EngineMessage>("message", id)?.unread;

describe("the phone offers the second action by the engine's rule", () => {
  /**
   * CONTROL. MUTATION WATCHED: make `sendAndDoneOffered` answer a constant `true` in
   * `live.ts` and the second half of this case goes red — the finished message keeps
   * offering an action that would change nothing.
   */
  it("an Ohbox source offers it; the same message, once finished, does not", async () => {
    const live = await scene();
    expect(live.actions.sendAndDoneOffered("m-1")).toBe(true);
    await live.actions.markSeen("m-1", false);
    expect(live.actions.sendAndDoneOffered("m-1")).toBe(false);
    live.store.close();
    live.fake.server.close();
  });
});

describe("the offer reads the Ohbox ON SCREEN", () => {
  /**
   * CONTROL. MUTATION WATCHED: read `engine.read()` instead of `presentedReader()` in
   * `sendAndDoneOffered` and this goes red — the raw mirror still holds a routed message in
   * INBOX, so the action would be offered over a row the Ohbox does not show.
   */
  it("a message the projection files elsewhere is not an Ohbox source", async () => {
    const live = await scene();
    /* The projection as the world hands it: the same mirror with this message routed out of
       the Ohbox. Built by hiding it, which is what a rule-presented row looks like to
       `ohboxView` — it is not in the list the Ohbox is drawn from. */
    const raw = live.engine.read();
    const elsewhere = {
      ...raw,
      list: <T,>(type: string) => (type === "message"
        ? (raw.list<T>(type) as unknown[]).filter((m) => (m as { id?: string }).id !== "m-1")
        : raw.list<T>(type)) as T[],
      get: <T,>(type: string, id: string) =>
        (type === "message" && id === "m-1" ? undefined : raw.get<T>(type, id)),
      entries: <T,>(type: string) => raw.entries<T>(type)
        .filter((e) => !(type === "message" && e.id === "m-1")),
    } as unknown as EntityReader;

    const projected = liveActions({
      engine: live.engine,
      toast: () => undefined,
      uuid,
      zone: "UTC",
      presented: () => elsewhere,
    });
    expect(projected.sendAndDoneOffered("m-1")).toBe(false);
    /* The positive control, through the same door: the projection that DOES hold the row. */
    const inbox = liveActions({
      engine: live.engine,
      toast: () => undefined,
      uuid,
      zone: "UTC",
      presented: () => live.engine.read(),
    });
    expect(inbox.sendAndDoneOffered("m-1")).toBe(true);
    live.store.close();
    live.fake.server.close();
  });
});

describe("the release runs only after the engine accepted the send", () => {
  /**
   * CONTROL. MUTATION WATCHED: pass `() => Promise.resolve(true)` instead of the outcome into
   * the intent inside `doneHalf`, or call the done half outside `sent()`'s outcome, and a
   * REFUSED send files the message it never delivered — this case goes red on both the read
   * and the sentence.
   */
  it("a refused send files nothing and says only the send's own sentence", async () => {
    const live = await scene((fake) => { fake.failNext("POST", "/drafts"); });
    const res = await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    expect(res.outcome).toBe("failed");
    expect(reads(live.mutations), "a refused send dispatched a read").toEqual([]);
    expect(unreadOf(live, "m-1"), "a refused send filed the source").toBe(true);
    expect(live.toasts).toEqual([sayArg(Copy.replyFailed)]);
    expect(live.toasts).not.toContain(Copy.toastSentAndDone);
    live.store.close();
    live.fake.server.close();
  });

  /** The positive control: an accepted send DOES file it, and says so once. */
  it("an accepted send files the source and says it once", async () => {
    const live = await scene();
    const res = await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    expect(res.outcome).toBe("sent");
    expect(reads(live.mutations)).toHaveLength(1);
    expect(reads(live.mutations)[0]!.messageIds).toEqual(["m-1"]);
    expect(reads(live.mutations)[0]!.unread).toBe(false);
    expect(unreadOf(live, "m-1")).toBe(false);
    /* ONE sentence: the ordinary "Reply sent." is not raised and replaced. */
    expect(live.toasts).toEqual([Copy.toastSentAndDone]);
    live.store.close();
    live.fake.server.close();
  });

  /**
   * CONTROL. MUTATION WATCHED: drop the `andDone ? doneHalf(messageId) : undefined` argument
   * from either send arm and the plain press below starts filing the source.
   */
  it("a plain reply is untouched — it sends and files nothing", async () => {
    const live = await scene();
    await live.actions.sendReply("m-1", "Donnerstag passt.", false);
    expect(reads(live.mutations)).toEqual([]);
    expect(unreadOf(live, "m-1")).toBe(true);
    expect(live.toasts).toEqual([Copy.replySent]);
    live.store.close();
    live.fake.server.close();
  });

  it("a forward takes the same action through the same rule", async () => {
    const live = await scene();
    const res = await live.actions.sendForward(
      "m-1", [{ name: null, address: "bo@fake.test" }], "fyi", null, [], true,
    );
    expect(res.outcome).toBe("sent");
    expect(reads(live.mutations)).toHaveLength(1);
    expect(live.toasts).toEqual([Copy.toastSentAndDone]);
    live.store.close();
    live.fake.server.close();
  });

  /**
   * CONTROL. MUTATION WATCHED: drop the `sendAt === null` test in `sendReply`'s done-half arm
   * and an APPOINTMENT files its source — a message still on the account, read as answered.
   */
  it("a Send-later appointment finishes nothing", async () => {
    const live = await scene();
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await live.actions.sendReply("m-1", "later please", false, null, at, [], true);
    expect(reads(live.mutations)).toEqual([]);
    expect(unreadOf(live, "m-1")).toBe(true);
    live.store.close();
    live.fake.server.close();
  });
});

/**
 * SEND IS NOT DONE (owner 2026-10-22: "I had a resurfaced message and clicked only send on it and
 * not send and done and it marked as done!"). The phone never had the web's settle arm; these hold
 * it that way: a plain reply leaves a pin and a booking where they were, Send + Done files the row
 * and its Undo re-pins it.
 */
describe("a plain reply leaves a resurfaced or booked message where it was", () => {
  type Live = Awaited<ReturnType<typeof scene>>;
  const stateOf = (live: Live, id: string): string | null =>
    (live.engine.read().get<EngineMessage>("message", id)?.triage?.state as string | undefined) ?? null;
  const resurfacedIds = (live: Live): string[] =>
    resurfacedThreads(live.engine.read()).flatMap((r) => r.members.map((m) => m.id));
  const filing = (live: Live) => live.mutations.filter((m) => m.kind === "mark_seen" || m.kind === "triage_set");

  it.each(["resurfaced", "bubbled_up"])("a plain reply to a %s message files nothing", async (state) => {
    const live = await scene(undefined, state);
    /* A pin is a Resurfaced row; a booking waits in the Resurface pile and is no row yet. */
    const row = state === "resurfaced";
    expect(resurfacedIds(live).includes("m-1")).toBe(row);
    if (row) expect(live.actions.sendAndDoneOffered("m-1"), "Send + Done sits beside Send").toBe(true);
    const res = await live.actions.sendReply("m-1", "Donnerstag passt.", false);
    expect(res.outcome).toBe("sent");
    expect(filing(live), "a plain Send filed the row").toEqual([]);
    expect(stateOf(live, "m-1")).toBe(state);
    expect(resurfacedIds(live).includes("m-1")).toBe(row);
    expect(live.toasts).toEqual([Copy.replySent]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL: Send + Done files the resurfaced row, and its Undo re-pins it", async () => {
    const live = await scene(undefined, "resurfaced");
    const res = await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    expect(res.outcome).toBe("sent");
    expect(reads(live.mutations)).toHaveLength(1);
    expect(reads(live.mutations)[0]!.via).toBeUndefined();
    expect(live.toasts).toEqual([Copy.toastSentAndDone]);
    expect(resurfacedIds(live)).not.toContain("m-1");
    expect(live.undos).toHaveLength(1);
    live.undos[0]!();
    await new Promise((r) => setTimeout(r, 50));
    expect(stateOf(live, "m-1")).toBe("resurfaced");
    expect(resurfacedIds(live)).toContain("m-1");
    live.store.close();
    live.fake.server.close();
  });
});

describe("the release rides the send's own row, whichever road confirms it", () => {
  /** The press queues (its attempt and its own flush both 500), and the reconnect flush confirms. */
  it("a Send + Done confirmed by the reconnect flush files its source once and says it once", async () => {
    const live = await scene();
    failSends(live.fake, 2);
    const res = await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    expect(res.outcome).toBe("queued");
    expect(unreadOf(live, "m-1"), "a queued send filed its source before it went").toBe(true);
    const flushed = [...(await flushQueued(live.engine, live.actions.releaseConfirmed)).values()];
    expect(flushed.map((o) => o.status)).toEqual(["confirmed"]);
    expect(unreadOf(live, "m-1"), "the send was confirmed by the flush and its source is still unfiled").toBe(false);
    expect(wireMarks(live.fake), "the release reached the wire more or less than once").toBe(1);
    const said = flushed[0]!.done;
    expect(said && sayArg(said.say), "the flush's confirmation lost the sentence the release earned").toBe(Copy.toastSentAndDone);
    expect(typeof flushed[0]!.done?.opts?.undo).toBe("function");
    // The next flush has nothing of this send left: no second release, no second delivery.
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(wireMarks(live.fake)).toBe(1);
    expect(live.fake.deliveries(), "the reconnect road did not deliver exactly once").toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("a Send + Done killed before the flush is filed from the restored row on the next start", async () => {
    const live = await scene();
    failSends(live.fake, 2);
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    live.store.close();

    const again = await bootEngine(deps, { origin: live.origin, token: "tok-1", accountId: "acct-1" });
    if (again.kind !== "ready") throw new Error("boot refused");
    await again.verifyIdentity();
    await again.engine.start();
    const acts = liveActions({ engine: again.engine, toast: () => undefined, uuid, zone: "UTC" });
    const [o] = [...(await flushQueued(again.engine, acts.releaseConfirmed)).values()];
    expect(o?.status).toBe("confirmed");
    expect(unreadOf(again, "m-1"), "the restored send was confirmed and its source is still unfiled").toBe(false);
    expect(wireMarks(live.fake)).toBe(1);
    expect(live.fake.deliveries(), "the next start did not deliver exactly once").toHaveLength(1);
    expect(o?.done && sayArg(o.done.say)).toBe(Copy.toastSentAndDone);
    again.store.close();
    live.fake.server.close();
  });

  it("a Send + Done given up on and tried again from the strip files its source, once for two presses", async () => {
    const live = await scene();
    failSends(live.fake, 2);
    await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    for (let i = 0; i < 12 && live.engine.abandoned().length === 0; i++) {
      failSends(live.fake, 1);
      await live.engine.flushPending();
    }
    const [row] = live.engine.abandoned();
    expect(row?.mutation.kind, "the send was not given up on").toBe("mail_send");
    live.toasts.length = 0;
    // Two presses: the second joins the first retry and shares its result.
    const [a, b] = await Promise.all([live.actions.retryAbandoned(row!.id), live.actions.retryAbandoned(row!.id)]);
    expect([a.status, b.status]).toEqual(["confirmed", "confirmed"]);
    expect(unreadOf(live, "m-1"), "a Send + Done tried again from the strip filed nothing").toBe(false);
    expect(wireMarks(live.fake), "one retry, released twice").toBe(1);
    expect(live.fake.deliveries(), "Try again did not deliver exactly once").toHaveLength(1);
    expect(live.toasts).toEqual([Copy.toastSentAndDone]);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL: a plain Send that queues files nothing when the flush confirms it", async () => {
    const live = await scene();
    failSends(live.fake, 2);
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false)).outcome).toBe("queued");
    const [o] = [...(await flushQueued(live.engine, live.actions.releaseConfirmed)).values()];
    expect(o?.status).toBe("confirmed");
    expect(o?.done).toBeNull();
    expect(unreadOf(live, "m-1")).toBe(true);
    expect(wireMarks(live.fake)).toBe(0);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL: a press confirmed at once files once, and the next flush adds nothing", async () => {
    const live = await scene();
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("sent");
    expect(wireMarks(live.fake)).toBe(1);
    expect(live.toasts).toEqual([Copy.toastSentAndDone]);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(wireMarks(live.fake)).toBe(1);
    expect(live.fake.deliveries(), "the live press did not deliver exactly once").toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  /** The press's own flush settles the whole queue: each send files, or not, by its own row. */
  it("CONTROL: two queued sends, one with Done — the second press's flush files only the first's source", async () => {
    const live = await scene((fake) => {
      fake.addMessage(dto("m-2", { subject: "Lunch", from: { name: "Bo", address: "bo@fake.test" } }));
    });
    failSends(live.fake, 2);
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    failSends(live.fake, 1);
    expect((await live.actions.sendReply("m-2", "Gern.", false)).outcome).toBe("sent");
    expect(unreadOf(live, "m-1"), "the Send + Done its flush confirmed was not filed").toBe(false);
    expect(unreadOf(live, "m-2"), "a plain send filed its source").toBe(true);
    expect(wireMarks(live.fake)).toBe(1);
    live.store.close();
    live.fake.server.close();
  });
});

/** Answer Later holds the answers you owe: a delivered reply pays it on every road, as the web's `settle` does. */
describe("a delivered reply takes its letter out of Answer Later", () => {
  type Live = Awaited<ReturnType<typeof scene>>;
  const owed = (live: { engine: Live["engine"] }): boolean =>
    live.engine.read().get<EngineMessage>("message", "m-1")?.triage?.state === "reply_later";
  const cleared = (live: Live): number =>
    live.fake.seen.filter((r) => r.method === "POST" && r.url === "/messages/m-1/triage" && JSON.parse(r.body).state === "none").length;

  it("a reply confirmed at the press", async () => {
    const live = await scene(undefined, "reply_later");
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false)).outcome).toBe("sent");
    expect(owed(live), "the answered letter is still owed").toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(cleared(live)).toBe(1);
    live.store.close();
    live.fake.server.close();
  });

  it("CONTROL: a refused send pays nothing", async () => {
    const live = await scene((fake) => { fake.failNext("POST", "/drafts"); }, "reply_later");
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false)).outcome).toBe("failed");
    expect(owed(live)).toBe(true);
    live.store.close();
    live.fake.server.close();
  });

  it("a reply the reconnect flush confirms, and one restored after a kill", async () => {
    const live = await scene(undefined, "reply_later");
    failSends(live.fake, 2);
    expect((await live.actions.sendReply("m-1", "Donnerstag passt.", false)).outcome).toBe("queued");
    expect(owed(live), "a queued reply paid before it went").toBe(true);
    await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(owed(live)).toBe(false);
    live.store.close();

    const other = await scene(undefined, "reply_later");
    failSends(other.fake, 2);
    expect((await other.actions.sendReply("m-1", "Gern.", false)).outcome).toBe("queued");
    other.store.close();
    const again = await bootEngine(deps, { origin: other.origin, token: "tok-1", accountId: "acct-1" });
    if (again.kind !== "ready") throw new Error("boot refused");
    await again.verifyIdentity();
    await again.engine.start();
    const acts = liveActions({ engine: again.engine, toast: () => undefined, uuid, zone: "UTC" });
    expect([...(await flushQueued(again.engine, acts.releaseConfirmed)).values()].map((o) => o.status)).toEqual(["confirmed"]);
    expect(owed(again), "the restored reply was confirmed and its letter is still owed").toBe(false);
    again.store.close();
    live.fake.server.close();
    other.fake.server.close();
  });
});

describe("one caller releases, and the reconnect flush is handed it", () => {
  it("CONTROL: only a CONFIRMED result releases — a refused one carrying a plan files nothing", async () => {
    const live = await scene();
    const plan: SendAndDonePlan = { section: "new", source: "m-1", messageIds: ["m-1"] };
    const refused = { id: "x", key: "k-refused", status: "rolled_back", seq: null, andDone: plan } as MutationResult;
    expect((await live.actions.releaseConfirmed([refused])).size, "a refused send released its plan").toBe(0);
    expect(reads(live.mutations)).toEqual([]);
    const confirmed = { id: "y", key: "k-confirmed", status: "confirmed", seq: null, andDone: plan } as MutationResult;
    expect([...(await live.actions.releaseConfirmed([confirmed])).keys()]).toEqual(["k-confirmed"]);
    expect(reads(live.mutations)).toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  const read = (rel: string): string => withoutComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  it("releaseConfirmed is the only call of applySendAndDone in the app, and sendAndDone is not called", () => {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const calls: string[] = [];
    let wrapped = 0;
    for (const f of walk(src)) {
      const text = withoutComments(readFileSync(f, "utf8"));
      for (const m of text.matchAll(/\bapplySendAndDone\(/g)) calls.push(`${f}:${m.index}`);
      wrapped += [...text.matchAll(/(?<![A-Za-z])sendAndDone\(/g)].length;
    }
    expect(calls, "a second road releases a Send + Done on its own").toHaveLength(1);
    expect(calls[0]).toContain("state/live.ts");
    expect(wrapped, "the in-memory release came back").toBe(0);
    const live = read("../src/state/live.ts");
    const body = live.slice(live.indexOf("const releaseConfirmed"), live.indexOf("const sent = async"));
    expect(body).toContain("applySendAndDone(");
  });

  it("the world hands the reconnect flush the release, and says its sentence instead of the ordinary one", () => {
    const world = read("../src/state/world.tsx");
    expect(world, "the reconnect flush is not handed the release").toContain("void flushQueued(flushed, acts.releaseConfirmed, (key) => {");
    expect(world).toContain("if (o.status === \"confirmed\" && o.done !== null) showToast(o.done.say, o.done.opts);");
  });
});

describe("both doors take it", () => {
  /**
   * The paired door and the standalone door share ONE actions layer, so the offer cannot
   * differ between them unless something reads the door. Send later DOES read it
   * (`sendLaterOffered` takes `standalone`); this action must not, and the composer must not
   * gate the button on it either.
   */
  it("nothing in the action or its button reads the standalone door", () => {
    const src = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const live = src("../src/state/live.ts");
    const offered = live.slice(live.indexOf("const sendAndDoneOffered"), live.indexOf("const donePlan"));
    expect(offered).not.toContain("standalone");

    const ui = src("../src/ui/MessageActions.tsx");
    const line = ui.split("\n").find((l) => l.includes("const andDoneOffered ="))!;
    expect(line, "the composer's offer is the actions layer's, unqualified").toContain("w.actions.sendAndDoneOffered(m.id)");
    expect(line).not.toContain("standalone");
    /* …and Send later's own line is the positive control that this file DOES read the door
       where the product says it should. */
    expect(ui).toContain("standalone: w.standalone");
  });
});
