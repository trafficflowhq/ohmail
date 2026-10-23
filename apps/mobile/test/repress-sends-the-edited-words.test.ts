/**
 * AN EDITED RE-PRESS DELIVERS THE EDITED WORDS (REPRESS-WITH-EDITED-WORDS-SENDS-THE-EARLIER-ONES),
 * unless a send already holds the row; then ONE sentence says the earlier words went. A resumed key
 * whose words differ from the row's (`fingerprintForKey`) PUTs them first, and the answer decides
 * the sentence: `draft` took them, 409 or a non-draft echo kept the earlier ones (`earlierWordsKept`).
 * Each road reads what was DELIVERED (the row's words when the server reserved), the PUTs, the sentence.
 * Mutations, each named at its case: the compare, the transport arm, the PUT-path row report, the
 * overlay gate, superseded-on-confirm.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EDIT_OWN_REFUSALS, HttpAdapter, type EngineMutation, type EntityReader } from "@ohmail/client-engine";
import { bootEngine, LOCAL_ENGINE_ORIGIN, type LocalEngineDoor, type MobileEngineDeps } from "../src/engine/boot";
import { installNetworkReader, networkNow, type NetworkReader } from "../src/net/network-door";
import { earlierVersionWent, flushQueued, liveActions, type ToastOpts } from "../src/state/live";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

afterEach(() => { installNetworkReader(null); });

function networkSwitch(): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state: "online" | "offline" = "online";
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) { state = s; for (const l of [...listeners]) l(s); },
  };
}

/**
 * One phone on the local door. Offline, the send step answers the unreachable 409 without reaching
 * the server. `loseNextAnswers(n)` lets n sends reach the server and drops their answers;
 * `dropNextPut()` fails the next PUT in transport without reaching the server. `wire` records each
 * send with the row's words at the moment the server took the request.
 */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  const net = networkSwitch();
  installNetworkReader(net.reader);
  let lose = 0;
  let dropPut = 0;
  /** Answers the next PUTs get instead of reaching the server: a status and a raw body. */
  const putAnswers: Array<{ status: number; body: string }> = [];
  const wire: Array<{ row: string; key: string | null; body: unknown }> = [];
  const forward = (req: Request, url: URL, body: string | undefined) =>
    fetch(`${origin}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
  const door: LocalEngineDoor = {
    sessionToken: "launch-1",
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "PUT" && putAnswers.length > 0 && url.pathname.startsWith("/drafts/")) {
        const a = putAnswers.shift()!;
        await req.text();
        return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
      }
      if (req.method === "PUT" && dropPut > 0 && url.pathname.startsWith("/drafts/")) {
        dropPut -= 1;
        await req.text();
        throw new TypeError("fetch failed");
      }
      const send = req.method === "POST" ? /^\/drafts\/([^/]+)\/send$/.exec(url.pathname) : null;
      if (send) {
        const key = req.headers.get("idempotency-key");
        if (networkNow() === "offline") {
          await req.text();
          return new Response(JSON.stringify({ status: "failed", message: "the mail server could not be reached" }), {
            status: 409, headers: { "content-type": "application/json" },
          });
        }
        const row = fake.draftRows().find((d) => String(d.id) === send[1]);
        wire.push({ row: send[1]!, key, body: (row as { body?: unknown } | undefined)?.body });
        if (lose > 0) {
          lose -= 1;
          const res = await forward(req, url, await req.text());
          await res.text();
          throw new TypeError("fetch failed");
        }
      }
      return forward(req, url, req.method === "GET" ? undefined : await req.text());
    },
  };
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open, deleteDatabase: world.drop, uuid,
    fetch: async () => { throw new Error("the global transport was used on the standalone door"); },
  };
  const toasts: Array<{ say: string; opts?: ToastOpts }> = [];
  const boot = async () => {
    const b = await bootEngine(deps, { origin: LOCAL_ENGINE_ORIGIN, accountId: "acct-1", localEngine: door, network: networkNow });
    if (b.kind !== "ready") throw new Error("boot refused");
    await b.engine.start();
    const shown: { reader: (() => EntityReader) | null } = { reader: null };
    const actions = liveActions({
      engine: b.engine, toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ? { opts } : {}) }), uuid, zone: "UTC",
      presented: () => shown.reader?.() ?? b.engine.read(),
    });
    return { engine: b.engine, store: b.store, actions };
  };
  const first = await boot();
  return {
    fake, origin, net, wire, toasts, ...first, boot,
    loseNextAnswers(n: number) { lose += n; },
    dropNextPut() { dropPut += 1; },
    answerNextPut(status: number, body: string) { putAnswers.push({ status, body }); },
  };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** The words each DELIVERY carried: the row's words when the server took the key's first send. */
const deliveredWords = (s: Scene): unknown[] => s.fake.deliveries().map((k) => s.wire.find((w) => w.key === k)?.body);
const contentPuts = (s: Scene): number => s.fake.seen.filter((r) => r.method === "PUT" && r.url.startsWith("/drafts/")).length;
const sendRequests = (s: Scene): number => s.fake.seen.filter((r) => r.method === "POST" && /\/send$/.test(r.url)).length;
const rowFor = (s: Scene) => s.fake.draftRows().find((d) => d.inReplyToMessageId === "m-1") as { body?: unknown } | undefined;
/** Every Sent copy the mirror shows, as text, so a copy carrying the edited words can be found. */
const sentCopies = (s: Scene): string[] => s.engine.read().list<{ folder?: string }>("message")
  .filter((x) => x.folder === "Sent").map((x) => JSON.stringify(x));
const replySent = sayArg(Copy.replySent);
const earlierWent = sayArg(Copy.replyEarlierWent);
const EARLIER = "Reply to Ada.";
const EDITED = "Reply to Ada, with the figures.";

describe("an edited re-press sends the edited words", () => {
  // Mutation: the resume compare (`rewrite`) pinned false → the earlier words, 0 PUTs.
  it("control 1 — the queued road: the edited words go, written to the row first, and said as sent", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    s.net.set("online");
    const said = s.toasts.length;
    expect((await s.actions.sendReply("m-1", EDITED, false)).outcome).toBe("sent");
    const reading = { delivered: deliveredWords(s), puts: contentPuts(s), said: s.toasts.slice(said).map((t) => t.say) };
    expect(reading, "the edited re-press delivered the earlier words").toEqual({
      delivered: [EDITED], puts: 1, said: [replySent],
    });
    s.store.close();
  }, 60_000);

  it("CONTROL: the same words re-pressed replay the row as it stands, with no PUT", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    s.net.set("online");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("sent");
    expect({ delivered: deliveredWords(s), puts: contentPuts(s), said: s.toasts.at(-1)?.say })
      .toEqual({ delivered: [EARLIER], puts: 0, said: replySent });
    s.store.close();
  }, 60_000);

  /**
   * THE RELOAD ROAD, on a reply bound to a draft row (the PUT road). The row is reported with the
   * words it holds, so after a restart a same-words press replays. An edited press after a restart is
   * a reply of its own: a restored send is held by no sheet, and nothing it promised is rewritten.
   * Mutation: drop the PUT-path `onDraftRow` report → the same-words press after the restart PUTs
   * blind over the sent row and says the earlier words went about words nobody changed.
   */
  it("control 1R — after a restart, an unchanged press over a sent row replays with no PUT and the plain sentence", async () => {
    const s = await scene();
    const made = await fetch(`${s.origin}/drafts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxId: "mb-1", inReplyToMessageId: "m-1", subject: "Re: Invoice 12", body: "", to: [] }),
    });
    const draftId = String(((await made.json()) as { id: unknown }).id);
    // The first answer lost after the server delivered, twice (the press and its own retry):
    // the reservation holds the earlier words and the send stands under its key.
    s.loseNextAnswers(2);
    expect((await s.actions.sendReply("m-1", EARLIER, false, null, null, [], false, draftId)).outcome).toBe("queued");
    expect(s.fake.deliveries()).toHaveLength(1);
    s.store.close();
    const after = await s.boot();
    const prints = after.engine.pendingMutations().map((p) => typeof (p as { createdRow?: { fingerprint?: unknown } }).createdRow?.fingerprint);
    expect(prints, "the restored send forgot which words its row holds").toEqual(["string"]);
    const putsBefore = contentPuts(s);
    const said = s.toasts.length;
    expect((await after.actions.sendReply("m-1", EARLIER, false, null, null, [], false, draftId)).outcome).toBe("sent");
    expect({ puts: contentPuts(s) - putsBefore, said: s.toasts.slice(said).map((t) => t.say), delivered: deliveredWords(s) })
      .toEqual({ puts: 0, said: [replySent], delivered: [EARLIER] });
    after.store.close();
  }, 60_000);

  it("control 1R — after a restart, edited words over a row still a draft are a reply of their own; the row goes unwritten", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    s.store.close();
    const after = await s.boot();
    s.net.set("online");
    const said = s.toasts.length;
    expect((await after.actions.sendReply("m-1", EDITED, false)).outcome).toBe("sent");
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    expect({ delivered: deliveredWords(s), puts: contentPuts(s), said: s.toasts.slice(said).map((t) => t.say) })
      .toEqual({ delivered: [EDITED, EARLIER], puts: 0, said: [replySent] });
    after.store.close();
  }, 60_000);

  // Mutation: read a 409 on the resume PUT as an ordinary refusal → "not sent" over a delivered reply.
  it("control 2 — belted: the reservation sent the earlier words; the PUT is refused, they stand, one sentence says so", async () => {
    const s = await scene();
    s.loseNextAnswers(2);
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    expect(s.fake.deliveries()).toHaveLength(1);
    const said = s.toasts.length;
    expect((await s.actions.sendReply("m-1", EDITED, false)).outcome).toBe("sent");
    expect({ delivered: deliveredWords(s), rowWords: rowFor(s)?.body, said: s.toasts.slice(said).map((t) => t.say) })
      .toEqual({ delivered: [EARLIER], rowWords: EARLIER, said: [earlierWent] });
    // Control 6 rides here. Mutation: paint the Sent copy under the flag → a copy with the edited words.
    expect(sentCopies(s).filter((c) => c.includes(EDITED)), "the mirror shows a Sent copy nobody received").toEqual([]);
    s.store.close();
  }, 60_000);

  /** RESIDUE, named: a server without the belt rewrites the sent row's words. The sentence is still true. */
  it("control 2U — unbelted (an older server): the row is rewritten, and the sentence still says the earlier words went", async () => {
    const s = await scene();
    s.fake.unbeltedSentRows();
    s.loseNextAnswers(2);
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    const said = s.toasts.length;
    expect((await s.actions.sendReply("m-1", EDITED, false)).outcome).toBe("sent");
    expect({ delivered: deliveredWords(s), residueRowWords: rowFor(s)?.body, said: s.toasts.slice(said).map((t) => t.say) })
      .toEqual({ delivered: [EARLIER], residueRowWords: EDITED, said: [earlierWent] });
    s.store.close();
  }, 60_000);

  // Mutation: the transport arm proceeds instead of re-queuing → the earlier words under "Reply sent.".
  it("control 4C — a resume whose PUT never answered sends nothing; the next flush writes, then sends the edited words", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    s.net.set("online");
    const sendsBefore = sendRequests(s);
    // The press and its own immediate retry both lose the save.
    s.dropNextPut();
    s.dropNextPut();
    expect((await s.actions.sendReply("m-1", EDITED, false)).outcome).toBe("queued");
    expect(sendRequests(s) - sendsBefore, "a send left behind a save that never answered").toBe(0);
    const outcomes = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect({ delivered: deliveredWords(s), puts: contentPuts(s), settled: [...outcomes.values()].map((o) => [o.status, o.earlierWent]) })
      .toEqual({ delivered: [EDITED], puts: 1, settled: [["confirmed", false]] });
    s.store.close();
  }, 60_000);

  // Mutation: superseded-on-confirm removed → the older's late confirmation also speaks for the key.
  it("control 3 — LOW-2, a send past its deadline then an edited re-press: the key's one sentence is the true one", async () => {
    const s = await scene();
    const release = s.fake.holdNext("POST", "/drafts/");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    expect(s.fake.deliveries()).toHaveLength(1);
    const again = await s.actions.sendReply("m-1", EDITED, false);
    release();
    await new Promise((r) => setTimeout(r, 200));
    // Every answer for the key, read raw (the ledger keeps one per key per flush and would hide a second speaker).
    const answers = [...await s.engine.flushPending(), ...await s.engine.flushPending()]
      .filter((r) => r.status !== "superseded" && r.status !== "queued");
    expect({
      again: again.outcome, delivered: deliveredWords(s), rowWords: rowFor(s)?.body,
      settled: answers.map((r) => ({ status: r.status, earlierWent: earlierVersionWent(r) })),
    }).toEqual({
      again: "queued", delivered: [EARLIER], rowWords: EARLIER, settled: [{ status: "confirmed", earlierWent: true }],
    });
    s.store.close();
  }, 60_000);

  /** Control 8: the newer press refused after the older was silenced — the older speaks, as the earlier words. */
  it("control 8 — one speaker: the newer press refused after the older confirmed, and the older speaks", async () => {
    const s = await scene();
    const release = s.fake.holdNext("POST", "/drafts/");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    expect((await s.actions.sendReply("m-1", EDITED, false)).outcome).toBe("queued");
    release();
    await new Promise((r) => setTimeout(r, 200));
    s.fake.answerNext("POST", "/drafts/", 409, { status: "failed", message: "The mail server refused the message." });
    const outcomes = await flushQueued(s.engine, s.actions.releaseConfirmed);
    const rest = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect({
      delivered: deliveredWords(s),
      settled: [...outcomes.values(), ...rest.values()].map((o) => ({ status: o.status, earlierWent: o.earlierWent })),
    }).toEqual({ delivered: [EARLIER], settled: [{ status: "confirmed", earlierWent: true }] });
    s.store.close();
  }, 60_000);
});

/** Control 2's two field cases: a change outside the plain body still earns the earlier-went sentence. */
describe("a change the plain words do not show", () => {
  const base = (over: Partial<Extract<EngineMutation, { kind: "mail_send" }>> = {}): EngineMutation => ({
    kind: "mail_send", inReplyTo: "m-1", body: EARLIER, ...over,
  } as EngineMutation);
  for (const [what, over] of [
    ["an html-only edit", { html: "<p>Reply to Ada, <b>with the figures</b>.</p>" }],
    ["an attachment-only change", { attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "QUFBQQ==" }] }],
  ] as const) {
    it(`${what} after the reservation sent: one delivery, said as the earlier message`, async () => {
      const s = await scene();
      s.loseNextAnswers(1);
      const firstMutation = what === "an attachment-only change"
        ? base({ attachments: [{ filename: "a.txt", contentType: "text/plain", contentBase64: "QkJCQg==" }] })
        : base();
      const first = await s.engine.mutate(firstMutation, { key: "k-field" });
      expect(first.status).toBe("queued");
      const second = await s.engine.mutate(base(over as never), { key: "k-field" });
      expect({ status: second.status, earlierWent: earlierVersionWent(second), delivered: s.fake.deliveries().length })
        .toEqual({ status: "confirmed", earlierWent: true, delivered: 1 });
      s.store.close();
    }, 60_000);
  }
});

/**
 * Control 5, THE SAVE-FIRST RACE: the re-press's save lands before the first send is reserved, so the
 * reservation reads the EDITED words, and "Reply sent." is true. One engine serializes its sends
 * and cannot reach this order, so it is driven on the adapter, as two surfaces sharing one key
 * would. The deleted mark said "the earlier words went" here.
 */
describe("the save-before-reservation race, on the adapter", () => {
  it("control 5 — the PUT commits first: the edited words go and the press says sent", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
    let gate: (() => void) | null = null;
    let held = 0;
    const delivered: unknown[] = [];
    const transport = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      if (init?.method === "POST" && /\/send$/.test(path)) {
        if (held === 0) { held += 1; await new Promise<void>((r) => { gate = r; }); }
        const id = path.split("/")[2];
        delivered.push((fake.draftRows().find((d) => String(d.id) === id) as { body?: unknown } | undefined)?.body);
      }
      return fetch(url, init);
    };
    const adapter = new HttpAdapter({ baseUrl: origin, fetch: transport as never, getCookie: () => null });
    const m1 = { kind: "mail_send", inReplyTo: "m-1", body: EARLIER, mailboxId: "mb-1", to: [{ name: null, address: "ada@fake.test" }] } as EngineMutation;
    const m2 = { ...m1, body: EDITED } as EngineMutation;
    const older = adapter.mutate(m1, { idempotencyKey: "k-s3" });
    while (gate === null) await new Promise((r) => setTimeout(r, 2));
    const newer = adapter.mutate(m2, { idempotencyKey: "k-s3" });
    while (!fake.seen.some((r) => r.method === "PUT")) await new Promise((r) => setTimeout(r, 2));
    (gate as () => void)();
    const [o1, o2] = await Promise.all([older, newer]);
    const asResult = (o: unknown) => ({ id: "x", key: "k-s3", status: "confirmed" as const, seq: null, ...(o as object) });
    expect({
      delivered: fake.deliveries().length, wentWords: delivered[0],
      newerEarlierWent: earlierVersionWent(asResult(o2)), olderEarlierWent: earlierVersionWent(asResult(o1)),
    }).toEqual({ delivered: 1, wentWords: EDITED, newerEarlierWent: false, olderEarlierWent: false });
    fake.server.close();
  }, 60_000);
});

/**
 * HIGH-1: a resumed key's save that is not answered — a 503, a 502,
 * a 429, a 200 that does not parse — re-queues under the same key and sends nothing; the next flush
 * saves and the one reservation answers. Mutation: the old guard path (no re-queue) → the press reads
 * failed, the key is forgotten, and the natural retry delivers a second message.
 */
describe("a resumed save that is not answered keeps its key", () => {
  const busy = JSON.stringify({ error: { code: "db_busy", message: "busy" } });
  for (const [what, status, body] of [
    ["503 db_busy", 503, busy],
    ["502", 502, "<html>bad gateway</html>"],
    ["429", 429, JSON.stringify({ error: { code: "rate_limited", message: "slow down" } })],
    ["an unparseable 200", 200, "{not json"],
  ] as const) {
    it(`${what}: queued under the same key, then ONE delivery`, async () => {
      const s = await scene();
      s.loseNextAnswers(2);
      expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
      const key = s.engine.pendingMutations()[0]!.key;
      s.answerNextPut(status, body);
      s.answerNextPut(status, body);
      const r = await s.actions.sendReply("m-1", EDITED, false);
      // The natural retry, where a press read as failed.
      if (r.outcome === "failed") await s.actions.sendReply("m-1", EDITED, false);
      const standing = s.engine.pendingMutations().map((p) => p.key);
      const outcomes = await flushQueued(s.engine, s.actions.releaseConfirmed);
      expect({
        outcome: r.outcome, standing, delivered: s.fake.deliveries().length,
        settled: [...outcomes.values()].map((o) => [o.status, o.earlierWent]),
      }).toEqual({ outcome: "queued", standing: [key], delivered: 1, settled: [["confirmed", true]] });
      s.store.close();
    }, 60_000);
  }

  it("the edit's own refusals are exactly the three the server raises from the patch", () => {
    // The same list `drafts-sent-words-frozen.test.ts` proves each of on a sent row.
    expect([...EDIT_OWN_REFUSALS].sort()).toEqual(["400 validation_failed", "413 draft_too_large", "413 payload_too_large"]);
  });

  /**
   * MEDIUM-B (VERIFY-026): the edit's own refusal on a resumed key whose earlier words WENT. The
   * server validates the patch before it reads the row, so a sent row answers it too; the adapter reads
   * the row first and, past `draft`, settles the key as the earlier words: the press says they went and
   * the composer closes on "sent", so no corrected press over a refused one exists to deliver a second
   * message. Mutation: throw the refusal without reading → "Sending didn't work" about a delivered reply,
   * the key dropped, and the next press delivers twice.
   */
  const FIXED = "Reply to Ada, figures attached.";
  for (const [what, status, code] of [
    ["400 validation_failed", 400, "validation_failed"],
    ["413 draft_too_large", 413, "draft_too_large"],
    ["413 payload_too_large", 413, "payload_too_large"],
  ] as const) {
    it(`${what} over a sent row: said as the earlier words, the key settled, one delivery`, async () => {
      const s = await scene();
      s.loseNextAnswers(2);
      expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
      s.answerNextPut(status, JSON.stringify({ error: { code, message: "refused" } }));
      const t0 = s.toasts.length;
      const r = await s.actions.sendReply("m-1", EDITED, false);
      await flushQueued(s.engine, s.actions.releaseConfirmed);
      expect({
        outcome: r.outcome, said: s.toasts.slice(t0).map((t) => t.say), standing: s.engine.pendingMutations().length,
        delivered: deliveredWords(s), rowWords: rowFor(s)?.body,
      }).toEqual({ outcome: "sent", said: [earlierWent], standing: 0, delivered: [EARLIER], rowWords: EARLIER });
      s.store.close();
    }, 60_000);
  }

  /* Over a restart the edited press never resumes the restored key (held by no sheet), so its sent row
     is never written: the edit goes as a reply of its own, and the key replays as it stood. */
  it("over a restart: the sent row is not written, and the edited words are a reply of their own", async () => {
    const s = await scene();
    s.loseNextAnswers(2);
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    s.store.close();
    const after = await s.boot();
    const r = await after.actions.sendReply("m-1", EDITED, false);
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    expect({ outcome: r.outcome, puts: contentPuts(s), delivered: deliveredWords(s), rowWords: rowFor(s)?.body })
      .toEqual({ outcome: "sent", puts: 0, delivered: [EARLIER, EDITED], rowWords: EARLIER });
    after.store.close();
  }, 60_000);

  /** The other half: over a row still a draft nothing went, so the refusal is true and is said. */
  it("the edit's own 400 over a row still a draft is the refusal, naming the row, and nothing went", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    s.net.set("online");
    s.answerNextPut(400, JSON.stringify({ error: { code: "validation_failed", message: "to entries must be { name?, address }" } }));
    const r = await s.actions.sendReply("m-1", EDITED, false);
    expect({ outcome: r.outcome, row: r.draftId === String(rowFor(s)?.["id" as never]), delivered: s.fake.deliveries().length })
      .toEqual({ outcome: "failed", row: true, delivered: 0 });
    expect((await s.actions.sendReply("m-1", FIXED, false, null, null, [], false, r.draftId ?? null)).outcome).toBe("sent");
    expect(deliveredWords(s)).toEqual([FIXED]);
    s.store.close();
  }, 60_000);
});

/**
 * MEDIUM-1: an unchanged replay over a sent row is not told its newer text was kept back. With no
 * fingerprint known, the flag needs the echo's revision to have MOVED (the server rewrote the row).
 * Mutation: the 200-over-a-sent-row arm without the revision compare → both unchanged replays read the flag.
 */
describe("an unchanged replay over a sent row", () => {
  const ADA = { kind: "mail_send" as const, inReplyTo: "m-1", subject: "Re: Invoice 12", body: EARLIER, mailboxId: "mb-1", to: [{ name: null, address: "ada@fake.test" }] };
  async function server() {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
    const adapter = () => new HttpAdapter({ baseUrl: origin, fetch: fetch as never, getCookie: () => null });
    const draft = async () => String(((await (await fetch(`${origin}/drafts`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxId: "mb-1", inReplyToMessageId: "m-1", subject: "Re: Invoice 12", body: "", to: [] }),
    })).json()) as { id: unknown }).id);
    return { fake, adapter, draft };
  }
  const flagged = (o: unknown) => (o as { earlierWordsKept?: unknown }).earlierWordsKept === true;

  it("a 0.25.x record (row and revision, no fingerprint) replayed with the same words: no flag", async () => {
    const { fake, adapter, draft } = await server();
    const m = { ...ADA, draftId: await draft() } as EngineMutation;
    let row: { id: string; revision: string | null } | null = null;
    await adapter().mutate(m, { idempotencyKey: "k-p2", onDraftRow: async (r) => { row = { id: r.id, revision: r.revision }; } });
    const o = await adapter().mutate(m, { idempotencyKey: "k-p2", createdRow: row! });
    expect({ flag: flagged(o), deliveries: fake.deliveries().length, revision: typeof row!.revision })
      .toEqual({ flag: false, deliveries: 1, revision: "string" });
    fake.server.close();
  }, 60_000);

  it("CONTROL — the same record over an older server that rewrote the row with other words: the flag", async () => {
    const { fake, adapter, draft } = await server();
    fake.unbeltedSentRows();
    const m = { ...ADA, draftId: await draft() } as EngineMutation;
    let row: { id: string; revision: string | null } | null = null;
    await adapter().mutate(m, { idempotencyKey: "k-p2c", onDraftRow: async (r) => { row = { id: r.id, revision: r.revision }; } });
    const o = await adapter().mutate({ ...m, body: EDITED } as EngineMutation, { idempotencyKey: "k-p2c", createdRow: row! });
    expect({ flag: flagged(o), deliveries: fake.deliveries().length }).toEqual({ flag: true, deliveries: 1 });
    fake.server.close();
  }, 60_000);

  it("a 0.25.x autosaved reply restored with no row record, the same words: no flag", async () => {
    const { fake, adapter, draft } = await server();
    const m = { ...ADA, draftId: await draft() } as EngineMutation;
    await adapter().mutate(m, { idempotencyKey: "k-p3" });
    const o = await adapter().mutate(m, { idempotencyKey: "k-p3" });
    expect({ flag: flagged(o), deliveries: fake.deliveries().length }).toEqual({ flag: false, deliveries: 1 });
    fake.server.close();
  }, 60_000);
});

/**
 * LOW-2: the withdraw handoff, behaviourally. The older send confirms while the newer press waits
 * behind it and goes silent; Cancel on the newer press then hands the older's confirmation over, said
 * as the earlier words. Mutation: drop the handoff in `withdrawQueued` → nothing speaks for the key.
 */
describe("Cancel on the newer press after the older confirmed silently", () => {
  it("the older's confirmation speaks, as the earlier words", async () => {
    const s = await scene();
    const release = s.fake.holdNext("POST", "/drafts/");
    expect((await s.actions.sendReply("m-1", EARLIER, false)).outcome).toBe("queued");
    const again = await s.actions.sendReply("m-1", EDITED, false);
    expect(again.outcome).toBe("queued");
    const key = s.engine.pendingMutations()[0]!.key;
    release();
    const by = Date.now() + 10_000;
    while (s.engine.inFlightMutations().length > 0 && Date.now() < by) await new Promise((r) => setTimeout(r, 5));
    // The server holds the key as sent (the earlier words went under it): Cancel says so, and the
    // newer words never go. The waiting confirmation speaks, as the earlier words.
    expect(await s.actions.withdrawSend(key)).toBe("on_the_wire");
    const outcomes = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect({ delivered: deliveredWords(s), settled: [...outcomes.values()].map((o) => [o.status, o.earlierWent]) })
      .toEqual({ delivered: [EARLIER], settled: [["confirmed", true]] });
    s.store.close();
  }, 60_000);
});
