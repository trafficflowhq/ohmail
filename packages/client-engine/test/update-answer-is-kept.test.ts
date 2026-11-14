import { describe, expect, it } from "vitest";
import {
  FixturesAdapter,
  HttpAdapter,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_ABANDONED_TYPE,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_TYPE,
  readRefreshAnswer,
  readUpdateAnswer,
  updateAnswerOf,
  type EngineAdapter,
  type EngineMutation,
  type FetchLike,
} from "@ohmail/client-engine";
import { classifyRefusal, UPDATE_ANSWER_CODES } from "../src/adapters/refusal-shape.js";

/**
 * A SERVER THAT SAYS "THIS APP IS TOO OLD" OR "I AM BEING UPDATED" HAS NOT JUDGED THE WRITE. Either
 * answer keeps a queued act queued, under its own key and uncounted, until a server takes it. No
 * server of this release sends either one; the stub below does.
 */
const TOO_OLD = { status: 426, code: "client_too_old" } as const;
const UPDATING = { status: 503, code: "server_updating" } as const;

const answer = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });

describe("the two update answers, as the refusal reader classifies them", () => {
  it("are exactly two codes", () => {
    expect([...UPDATE_ANSWER_CODES].sort()).toEqual(["client_too_old", "server_updating"]);
  });

  it("a write answered with either is retryable whatever the envelope says", () => {
    for (const { status, code } of [TOO_OLD, UPDATING]) {
      expect(classifyRefusal(status, { code }, "write"), code).toEqual({ code, retryable: true });
      expect(classifyRefusal(status, { code, retryable: false }, "write"), `${code}, said not retryable`)
        .toEqual({ code, retryable: true });
    }
  });

  it("control: a 426 without our code is the refusal it always was", () => {
    expect(classifyRefusal(426, undefined, "write").retryable, "a bare 426").toBe(false);
    expect(classifyRefusal(426, { code: "upgrade_required" }, "write").retryable, "another code").toBe(false);
  });

  it("an answer is one only by status and code together", async () => {
    expect(updateAnswerOf(426, "client_too_old")).toBe("tooOld");
    expect(updateAnswerOf(503, "server_updating")).toBe("serverUpdating");
    for (const [status, code] of [[426, null], [426, "server_updating"], [503, "client_too_old"], [503, "db_busy"],
      [500, "client_too_old"], [200, "client_too_old"]] as const) {
      expect(updateAnswerOf(status, code), `${status} ${code}`).toBeNull();
    }
    expect(await readUpdateAnswer(answer(426, { code: "client_too_old" }))).toBe("tooOld");
    expect(await readUpdateAnswer(answer(503, { code: "server_updating" }))).toBe("serverUpdating");
    expect(await readUpdateAnswer(new Response("<html>upgrade</html>", { status: 426 })), "a page, not ours").toBeNull();
    expect(await readUpdateAnswer(new Response("Service Unavailable", { status: 503 })), "an edge's 503").toBeNull();
  });

  it("reading an answer leaves the body to its caller", async () => {
    const res = answer(426, { code: "client_too_old", message: "too old" });
    expect(await readUpdateAnswer(res)).toBe("tooOld");
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("too old");
  });
});

describe("a queued act that meets an update answer", () => {
  const VERB: EngineMutation = { kind: "mark_seen", messageIds: ["giulia"], unread: false };

  /** The real adapter's write door over a stub server; reads come from the fixtures. */
  function rig() {
    const start = Date.parse("2026-11-13T12:00:00.000Z");
    let t = start;
    const keys: string[] = [];
    let respond: () => Response = () => new Response("{}", { status: 200 });
    const fetchImpl: FetchLike = async (_url, init) => {
      keys.push(String((init?.headers as Record<string, string> | undefined)?.["idempotency-key"] ?? ""));
      return respond();
    };
    const http = new HttpAdapter({ baseUrl: "http://stub.test", fetch: fetchImpl });
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (params) => inner.sync(params),
      // What the stub server takes, the fixtures apply: the next drain then carries the echo.
      mutate: async (m, o) => {
        const out = await http.mutate(m, o);
        await inner.mutate(m, o);
        return out;
      },
    };
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => new Date(t) });
    return {
      engine, store, keys,
      says: (next: () => Response) => { respond = next; },
      advance: (ms: number) => { t += ms; },
    };
  }

  const cases: Array<{ name: string; refuse: () => Response }> = [
    { name: "426 client_too_old", refuse: () => answer(426, { code: "client_too_old", message: "too old", retryable: true }) },
    { name: "426 client_too_old, said not retryable", refuse: () => answer(426, { code: "client_too_old", retryable: false }) },
    { name: "503 server_updating naming 30 s", refuse: () => answer(503, { code: "server_updating", retryable: true }, { "retry-after": "30" }) },
    { name: "503 server_updating naming nothing", refuse: () => answer(503, { code: "server_updating" }) },
  ];

  for (const { name, refuse } of cases) {
    it(`${name}: still queued after nine drives, same key, nothing counted, and it leaves on a 200`, async () => {
      const r = rig();
      await r.engine.start();
      r.says(refuse);

      expect((await r.engine.mutate(VERB)).status, "the act was refused or dropped").toBe("queued");
      for (let i = 0; i < 9; i++) {
        r.advance(OUTBOX_BACKOFF_BASE_MS + 1);
        await r.engine.syncOnce();
      }

      const kept = r.store.entries<{ key: string; attempts?: number; v: number }>(OUTBOX_TYPE);
      expect(kept, "the act left the queue").toHaveLength(1);
      expect(r.store.entries(OUTBOX_ABANDONED_TYPE), "the act was given up on").toHaveLength(0);
      expect(kept[0]!.entity.attempts ?? 0, "an update answer spent the give-up ceiling").toBe(0);
      expect(kept[0]!.entity.v).toBe(3);
      expect(r.keys, "one try at the press and one per drive").toHaveLength(10);
      expect(new Set(r.keys), "a try left under another key").toEqual(new Set([kept[0]!.entity.key]));
      expect(r.engine.pendingMutations()).toHaveLength(1);

      r.says(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
      r.advance(OUTBOX_BACKOFF_BASE_MS + 1);
      await r.engine.syncOnce();
      expect(r.store.entries(OUTBOX_TYPE), "the server took it and it stayed queued").toHaveLength(0);
      expect(r.engine.pendingMutations()).toHaveLength(0);
      expect(r.keys.at(-1)).toBe(kept[0]!.entity.key);
    });
  }

  it("a drive does not ask a server again before its wait is over", async () => {
    const r = rig();
    await r.engine.start();
    r.says(() => answer(426, { code: "client_too_old" }));
    await r.engine.mutate(VERB);
    expect(r.keys).toHaveLength(1);
    await r.engine.syncOnce();
    await r.engine.syncOnce();
    expect(r.keys, "a drive hammered a server that answers the same way until the app is updated").toHaveLength(1);
    r.advance(OUTBOX_BACKOFF_BASE_MS);
    await r.engine.syncOnce();
    expect(r.keys).toHaveLength(2);
  });

  it("a rejection built by hand with either code is kept too", async () => {
    for (const { status, code } of [TOO_OLD, UPDATING]) {
      const inner = new FixturesAdapter();
      const adapter: EngineAdapter = {
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: () => inner.fetchBody(),
        sync: (params) => inner.sync(params),
        mutate: async () => { throw new MutationRejectedError(code, { status, code, retryable: false }); },
      };
      const store = new MemoryMirrorStore();
      const engine = new OhmailEngine({ adapter, store, now: () => new Date("2026-11-13T12:00:00.000Z") });
      await engine.start();
      expect((await engine.mutate(VERB)).status, code).toBe("queued");
      expect(store.entries(OUTBOX_TYPE), code).toHaveLength(1);
    }
  });
});

describe("a send and a move, and an update answer", () => {
  const TO = [{ name: null, address: "anna@example.test" }];
  /** What Compose sends once autosave has written the row: the row, the picked From, the words. */
  const COMPOSED: EngineMutation = {
    kind: "mail_send", inReplyTo: null, draftId: "d1", mailboxId: "mb1", threadId: null,
    subject: "Friday", body: "See you then.", to: TO, cc: [], bcc: [],
  };
  const BLIND: EngineMutation = { ...COMPOSED, bcc: [{ name: null, address: "ben@example.test" }] };
  /** A row sent with no picked From: the third guard's press, which only the adapter meets. */
  const BARE: EngineMutation = { kind: "mail_send", inReplyTo: null, draftId: "d1", threadId: null, subject: "Friday", body: "See you then.", to: TO };
  const SENDS: Array<{ name: string; m: EngineMutation }> = [
    { name: "a composed letter", m: COMPOSED },
    { name: "a composed letter with a blind copy", m: BLIND },
  ];
  const MOVE: EngineMutation = { kind: "move", messageId: "giulia", folder: "archive" };
  const ANSWERS: Array<{ name: string; refuse: () => Response }> = [
    { name: "426 client_too_old", refuse: () => answer(426, { code: "client_too_old", message: "too old", retryable: true }) },
    { name: "503 server_updating naming 30 s", refuse: () => answer(503, { code: "server_updating", retryable: true }, { "retry-after": "30" }) },
    { name: "503 server_updating naming nothing", refuse: () => answer(503, { code: "server_updating" }) },
  ];

  type Mode = "down" | "answer" | "accept";

  /** The real adapter over a stub server that is out of reach, answers every route one way, or takes the write. */
  function rig(refuse: () => Response, bcc: unknown[] = []) {
    let t = Date.parse("2026-11-13T12:00:00.000Z");
    let mode: Mode = "accept";
    const wire: Array<{ line: string; key: string; status: number | "down" }> = [];
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const accept = (method: string, path: string): Response => {
      if (method === "PUT" && path.startsWith("/drafts/")) {
        return json(200, { id: path.split("/")[2], status: "draft", contentRevision: "r2", mailboxId: "mb1", bcc });
      }
      if (method === "POST" && path.endsWith("/send")) return json(200, { status: "sent", providerMessageId: "<sent@example.test>" });
      return json(200, {});
    };
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? "GET";
      const path = String(url).replace("http://stub.test", "");
      const key = String((init?.headers as Record<string, string> | undefined)?.["idempotency-key"] ?? "");
      const line = `${method} ${path}`;
      // Out of reach: the save still lands, the act itself does not.
      if (mode === "down" && method === "POST") {
        wire.push({ line, key, status: "down" });
        throw new TypeError("network down");
      }
      const res = mode === "answer" ? refuse() : accept(method, path);
      wire.push({ line, key, status: res.status });
      return res;
    };
    const http = new HttpAdapter({ baseUrl: "http://stub.test", fetch: fetchImpl });
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (params) => inner.sync(params),
      mutate: async (m, o) => {
        const out = await http.mutate(m, o);
        if (m.kind !== "mail_send") await inner.mutate(m, o);
        return out;
      },
    };
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter, store, now: () => new Date(t) });
    /** One drive: the host's own "try now" (the road a waiting send takes), then the engine's replay. */
    const drive = async (times: number): Promise<void> => {
      for (let i = 0; i < times; i++) {
        t += OUTBOX_BACKOFF_BASE_MS + 1;
        await engine.flushPending();
        await engine.syncOnce();
      }
    };
    const taken = (tail: string) => wire.filter((w) => w.line.endsWith(tail) && w.status === 200);
    return { engine, store, wire, drive, taken, mode: (next: Mode) => { mode = next; } };
  }

  it("the save before a send hands the answer on as it came, whatever the row's own guards would say", async () => {
    for (const { name: said, refuse } of ANSWERS) {
      for (const [shape, m] of [["a picked From", COMPOSED], ["a blind copy", BLIND], ["neither", BARE]] as const) {
        const lines: string[] = [];
        const http = new HttpAdapter({
          baseUrl: "http://stub.test",
          fetch: async (url, init) => { lines.push(`${init?.method ?? "GET"} ${String(url).replace("http://stub.test", "")}`); return refuse(); },
        });
        const thrown = await http.mutate(m, { idempotencyKey: "k1" }).catch((e: unknown) => e);
        const expected = refuse();
        expect(thrown, `${said}, ${shape}`).toBeInstanceOf(MutationRejectedError);
        const r = thrown as MutationRejectedError;
        expect({ code: r.code, status: r.status, retryable: r.retryable }, `${said}, ${shape}`).toEqual({
          code: ((await expected.json()) as { error: { code: string } }).error.code, status: expected.status, retryable: true,
        });
        expect(r.retryAfterMs, `${said}, ${shape}`).toBe(expected.headers.has("retry-after") ? 30_000 : null);
        expect(lines, `${said}, ${shape}: one save, and the key never shown to the send`).toEqual(["PUT /drafts/d1"]);
      }
    }
  });

  for (const { name: said, refuse } of ANSWERS) {
    for (const { name, m } of SENDS) {
      it(`${said}: ${name} pressed under it waits, and is sent once when the server takes it`, async () => {
        const r = rig(refuse, m.kind === "mail_send" ? m.bcc ?? [] : []);
        await r.engine.start();
        r.mode("answer");

        const pressed = await r.engine.mutate(m);
        expect(pressed.status, `the press was refused: ${pressed.error?.code}`).toBe("queued");
        await r.drive(9);

        const kept = r.store.entries<{ key: string; attempts?: number }>(OUTBOX_TYPE);
        expect(kept, "the send left the queue").toHaveLength(1);
        expect(r.store.entries(OUTBOX_ABANDONED_TYPE), "the send was given up on").toHaveLength(0);
        expect(kept[0]!.entity.attempts ?? 0, "an update answer spent the give-up ceiling").toBe(0);
        expect(r.wire.filter((w) => w.line.endsWith("/send")), "the key was shown to the send before the row was saved").toEqual([]);

        r.mode("accept");
        await r.drive(2);
        const sent = r.taken("/send");
        expect(sent, "sent once").toHaveLength(1);
        expect(sent[0]!.key).toBe(kept[0]!.entity.key);
        const lines = r.wire.map((w) => w.line);
        expect(lines.lastIndexOf("PUT /drafts/d1"), "the row was saved before it was sent").toBeLessThan(lines.indexOf("POST /drafts/d1/send"));
        expect(r.store.entries(OUTBOX_TYPE)).toHaveLength(0);
        expect(r.engine.pendingMutations()).toHaveLength(0);
      });
    }

    it(`${said}: a send and a move queued before it are still queued after nine drives, and each leaves once`, async () => {
      const r = rig(refuse);
      await r.engine.start();
      r.mode("down");
      expect((await r.engine.mutate(COMPOSED)).status).toBe("queued");
      expect((await r.engine.mutate(MOVE)).status).toBe("queued");
      const planted = r.store.entries<{ key: string }>(OUTBOX_TYPE).map((e) => e.entity.key).sort();
      expect(planted).toHaveLength(2);

      r.mode("answer");
      await r.drive(9);
      const kept = r.store.entries<{ key: string; attempts?: number }>(OUTBOX_TYPE);
      expect(kept.map((e) => e.entity.key).sort(), "a key changed, or an act left the queue").toEqual(planted);
      expect(r.store.entries(OUTBOX_ABANDONED_TYPE), "an act was given up on").toHaveLength(0);
      expect(kept.map((e) => e.entity.attempts ?? 0), "an update answer spent the give-up ceiling").toEqual([0, 0]);

      r.mode("accept");
      await r.drive(2);
      const sent = r.taken("/send");
      const moved = r.taken("/move");
      expect([sent.length, moved.length], "each leaves exactly once").toEqual([1, 1]);
      expect([sent[0]!.key, moved[0]!.key].sort()).toEqual(planted);
      expect(r.store.entries(OUTBOX_TYPE)).toHaveLength(0);
    });
  }
});

describe("the refresh door and an update answer", () => {
  it("is a fault, never the end of the session", async () => {
    expect(await readRefreshAnswer(answer(426, { code: "client_too_old" }))).toEqual({ kind: "fault", code: "client_too_old" });
    expect(await readRefreshAnswer(answer(503, { code: "server_updating" }, { "retry-after": "30" })))
      .toEqual({ kind: "fault", code: "server_updating" });
  });
});
