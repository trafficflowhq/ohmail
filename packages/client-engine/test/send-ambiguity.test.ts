/**
 * I4 + I5 — AN ANSWER THIS CLIENT CANNOT READ IS AMBIGUITY, NEVER FAILURE.
 *
 * ── THE LIVE DEFECT THESE GUARD ──────────────────────────────────────────────────────────────
 *
 * `POST /drafts/:id/send` answers `unverified` at 200, `queued` at 202, `failed`/`in_flight` at
 * 409. When the body could not be parsed — truncated, rewritten by a proxy, a 200 that never
 * finished writing — the adapter fell through to the generic envelope, where
 * `retryable ?? (status >= 500 || status === 429)` reads 200/202/409 as NOT retryable. That became
 * a terminal refusal: the overlay rolled back, the composer unlocked, and the next press minted a
 * FRESH Idempotency-Key.
 *
 * On the mobile path that is a second delivery. Mobile sends carry no `draftId`, so the server's
 * "409 for a non-draft row" guard — which protects a NAMED draft — cannot see the second attempt:
 * it is a new `POST /drafts` followed by a new send. This predates the outbox bound and is live on
 * the hosted service.
 *
 * ── WHY RETRYING IS THE SAFE ACT AND GIVING UP IS THE DANGEROUS ONE ─────────────────────────
 *
 * The same key replayed is not a resend. `SendService.resumeExisting` verifies by reservation and
 * by the Sent folder before it does anything, so a replay can only confirm, fail definitively, or
 * stay unverified. Every branch below therefore keeps the key and stays retryable — and the
 * ceiling exempts the codes it uses, because eight unreadable answers are eight unknowns rather
 * than eight pieces of evidence about the verb.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  HttpAdapter,
  IndexedDbMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_ABANDONED_TYPE,
  OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_MAX_SERVER_FAILURES,
  OUTBOX_UNREACHABLE_CEILING_MS,
  type EngineMutation,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/** A response whose body is not JSON, at a status that says the server ACTED. */
const unreadable = (status: number): Response =>
  new Response("{", { status, headers: { "content-type": "application/json" } });

/**
 * The shape the engine actually enriches and dispatches. Hand-rolled field sets were rejected
 * before the adapter was ever called, which read as "zero requests" and would have made every
 * count below vacuously true.
 */
const SEND: EngineMutation = {
  kind: "mail_send",
  inReplyTo: null,
  mailboxId: "mbx-1",
  subject: "quarterly numbers",
  body: "see attached",
  to: [{ name: null, address: "to@example.test" }],
  cc: [],
  bcc: [],
} as unknown as EngineMutation;

/**
 * The adapter over a scripted fetch. Every call is recorded with its method, path and
 * Idempotency-Key, because the assertion that matters most is "how many `POST /drafts` did this
 * produce" — a second one is the duplicate delivery.
 */
function scripted(script: Array<(url: string, init: RequestInit) => Response>) {
  const calls: Array<{ method: string; path: string; key: string | null }> = [];
  let i = 0;
  const fetchImpl = async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers as HeadersInit | undefined);
    calls.push({
      method: (init.method ?? "GET").toUpperCase(),
      path: new URL(url, "http://x").pathname,
      key: headers.get("idempotency-key"),
    });
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return step(url, init);
  };
  void 0;
  const adapter = new HttpAdapter({
    baseUrl: "http://x",
    fetch: fetchImpl as unknown as typeof fetch,
  } as never);
  return { adapter, calls };
}


/**
 * A real `FixturesAdapter` whose `mutate` always refuses. Real sync, real body reads — only the
 * write is scripted, which is the smallest lie that still exercises the engine's own roads.
 */
function failing(inner: FixturesAdapter, reject: () => MutationRejectedError) {
  return {
    fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
    sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
    mutate: async () => { throw reject(); },
  } as unknown as Parameters<typeof OhmailEngine.prototype.constructor>[0]["adapter"];
}

describe("I4 — an unreadable answer on the send route", () => {
  for (const [status, expected] of [[200, "send_in_flight"], [202, "send_queued"], [409, "send_in_flight"]] as const) {
    it(`a ${status} whose body will not parse is retryable \`${expected}\`, not a refusal`, async () => {
      const { adapter } = scripted([
        () => new Response(JSON.stringify({ id: "d1" }), { status: 201 }),  // POST /drafts
        () => unreadable(status),                                           // POST /drafts/d1/send
      ]);

      const err = await adapter.mutate(SEND, { idempotencyKey: "k-1" }).then(
        () => null,
        (e: unknown) => e as MutationRejectedError,
      );

      expect(err, `a ${status} must not resolve`).toBeInstanceOf(MutationRejectedError);
      // RED BEFORE THE FIX: this was `false`, which is what unlocked the composer and freed the
      // next press to mint a new key.
      expect(err!.retryable).toBe(true);
      expect(err!.code).toBe(expected);
      expect(err!.status).toBe(status);
    });
  }

  it("the retry is the SAME key and mints no second draft — the duplicate-delivery assertion", async () => {
    // PATH-DRIVEN, not positional: the second attempt SKIPS the create (the ambiguous arm keeps
    // `draftForKey`), so a script that answers by call order hands it the wrong response and the
    // test fails for a reason that has nothing to do with the product.
    const calls: Array<{ method: string; path: string; key: string | null }> = [];
    let sends = 0;
    const fetchImpl = async (input: unknown, init: RequestInit = {}) => {
      const path = new URL(String(input), "http://x").pathname;
      const headers = new Headers(init.headers as HeadersInit | undefined);
      calls.push({ method: (init.method ?? "GET").toUpperCase(), path, key: headers.get("idempotency-key") });
      if (path === "/drafts") return new Response(JSON.stringify({ id: "d1" }), { status: 201 });
      sends += 1;
      // First send: unreadable. Second: the server recognises the key and answers terminally.
      return sends === 1
        ? unreadable(202)
        : new Response(JSON.stringify({ status: "sent", providerMessageId: "<m@x>" }), { status: 200 });
    };
    const adapter = new HttpAdapter({
      baseUrl: "http://x", fetch: fetchImpl as unknown as typeof fetch,
    } as never);

    await adapter.mutate(SEND, { idempotencyKey: "k-2" }).catch(() => undefined);
    await adapter.mutate(SEND, { idempotencyKey: "k-2" });

    const creates = calls.filter((c) => c.method === "POST" && c.path === "/drafts");
    // ONE create across both attempts. TWO is the second delivery this whole file is about.
    expect(creates).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith("/send")).every((c) => c.key === "k-2")).toBe(true);
  });

  it("a 2xx create whose body will not parse is `unreadable_response`, never `no draft was made`", async () => {
    const { adapter } = scripted([() => new Response("{", { status: 201 })]);
    const err = await adapter.mutate(SEND, { idempotencyKey: "k-3" }).then(
      () => null, (e: unknown) => e as MutationRejectedError,
    );
    expect(err!.code).toBe("unreadable_response");
    expect(err!.retryable).toBe(true);
    // Carries the status, so the ceiling can attribute it rather than reading it as transport.
    expect(err!.status).toBe(201);
  });
});

describe("I4 — giving up on a send says `check Sent`, never `failed`", () => {
  it("eight unmodelled answers recode the record to send_unverified", async () => {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-sendabandon", factory });
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: failing(new FixturesAdapter(), () => {
        calls += 1;
        return new MutationRejectedError("internal error", {
          status: 500, code: "internal", retryable: true,
        });
      }),
      store,
      now: () => new Date(t),
    });
    await engine.start();

    // `mail_send` is OWNER-SETTLED (`ownerSettled`): the drive deliberately never replays it,
    // because a surface is waiting on the result. `flushPending` is its road, so the ceiling is
    // reached through the road the verb actually travels — driving `syncOnce` here called the
    // adapter zero times and every assertion below would have been vacuous.
    const res = await engine.mutate(SEND);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      t += OUTBOX_BACKOFF_CAP_MS + 1;
      await engine.flushPending();
    }
    expect(calls, `engine answered ${res.status}/${res.error?.code ?? "-"}`).toBe(OUTBOX_MAX_SERVER_FAILURES);

    const abandoned = engine.abandoned();
    expect(abandoned).toHaveLength(1);
    // RED BEFORE THE FIX: this was `internal`, and the surface rendered it as an ordinary
    // failure — which is the sentence that makes somebody press send again.
    expect(abandoned[0]!.error.code).toBe("send_unverified");
    expect(abandoned[0]!.error.message).toContain("Sent folder");
    expect(res.key).toBe(abandoned[0]!.key);

    // The persisted record says it too: the result is read by whoever pressed, the record by
    // whoever opens the list tomorrow, and either one saying "failed" buys a duplicate.
    const row = store.entries<{ lastError?: { code?: string } }>(OUTBOX_ABANDONED_TYPE)[0]!;
    expect(row.entity.lastError?.code).toBe("send_unverified");
    store.close();
  });
});

describe("I5 — what may and may not spend the ceiling", () => {
  const drive = async (
    owner: string, reject: () => MutationRejectedError, drives: number, step = OUTBOX_BACKOFF_CAP_MS + 1,
  ) => {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner, factory });
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: failing(new FixturesAdapter(), () => { calls += 1; return reject(); }),
      store,
      now: () => new Date(t),
    });
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    for (let i = 0; i < drives; i++) {
      t += step;
      await engine.flushPending();
    }
    const out = { calls, abandoned: engine.abandoned().length };
    store.close();
    return out;
  };

  it("the sidecar's `503 offline_read_only` never abandons — it is the offline case in a server's clothes", async () => {
    // `cloud-proxy.ts#offlineResponse`: 503, retryable, and NO `Retry-After`, because it does not
    // know when the network returns. Counting it means an ordinary Cloud outage discards eight
    // verbs' worth of work on reconnect. Fifty drives inside the day it was made: past a day the
    // verb is SHOWN instead, by age (`outbox-unreachable-and-unpainted.test.ts`), never by count.
    const r = await drive("acct-offline-ro", () => new MutationRejectedError("offline", {
      status: 503, code: "offline_read_only", retryable: true,
    }), 50, Math.floor(OUTBOX_UNREACHABLE_CEILING_MS / 60));
    expect(r.abandoned).toBe(0);
    expect(r.calls).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
  });

  it("a bare 429 with no body and no header never abandons — a throttle is a wait", async () => {
    const r = await drive("acct-bare-429", () => new MutationRejectedError("HTTP 429", {
      status: 429, code: null, retryable: true,
    }), 50);
    expect(r.abandoned).toBe(0);
    expect(r.calls).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
  });

  it("an unreadable 2xx never abandons either — ambiguity is not evidence about the verb", async () => {
    const r = await drive("acct-unreadable", () => new MutationRejectedError("unreadable", {
      status: 201, code: "unreadable_response", retryable: true,
    }), 50);
    expect(r.abandoned).toBe(0);
  });

  it("an ordinary unhandled 500 still does abandon — the bound is not disarmed", async () => {
    // The control. Without it every assertion above is satisfied by a ceiling that never fires.
    const r = await drive("acct-control-500", () => new MutationRejectedError("internal error", {
      status: 500, code: "internal", retryable: true,
    }), OUTBOX_MAX_SERVER_FAILURES * 2);
    expect(r.abandoned).toBe(1);
    expect(r.calls).toBe(OUTBOX_MAX_SERVER_FAILURES);
  });
});

describe("I5 — every hand-built rejection carries Retry-After", () => {
  it("no `new MutationRejectedError` in the adapter that has a status omits the header", async () => {
    // Derived from the SOURCE, so a site added later is covered without anyone remembering. The
    // two fixes that prompted this were found by a review reading every construction site; this
    // makes that reading a test.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/adapters/http-adapter.ts", import.meta.url), "utf8",
    );
    const lines = src.split("\n");
    const missing: string[] = [];
    lines.forEach((l, i) => {
      if (!l.includes("new MutationRejectedError(")) return;
      // Bounded by the construction's OWN closing `);`, never a fixed window — a 12-line slice
      // reached into the NEXT rejection and reported a transport catch (which has no status, and
      // rightly no header) as a violation. A scan that flags the innocent site is a scan people
      // learn to override.
      let depth = 0, end = i;
      for (let k = i; k < Math.min(lines.length, i + 30); k++) {
        depth += (lines[k]!.match(/\(/g) ?? []).length - (lines[k]!.match(/\)/g) ?? []).length;
        if (depth <= 0 && k > i) { end = k; break; }
      }
      const block = lines.slice(i, end + 1).join("\n");
      const hasStatus = /status:\s*[a-zA-Z]/.test(block);
      const retryable = /retryable:\s*(true|[a-z]+\.[a-zA-Z]|env\.|wire\.|put\.status|res\.status)/.test(block);
      if (hasStatus && retryable && !block.includes("retryAfterMs")) missing.push(`line ${i + 1}`);
    });
    expect(missing, "a retryable rejection that knows its status must carry Retry-After").toEqual([]);
  });
});

describe("a 2xx that PARSES but does not carry what it promised", () => {
  it("a JSON `null` body on a create is ambiguity, not a refusal", async () => {
    // It used to throw a TypeError on the first field access, which `dispatch` wrapped as a
    // terminal refusal — so the client dropped its key and the next attempt created a second row.
    const { adapter } = scripted([() => new Response("null", {
      status: 201, headers: { "content-type": "application/json" },
    })]);
    const err = await adapter.mutate(SEND, { idempotencyKey: "k-null" }).then(
      () => null, (e: unknown) => e as MutationRejectedError,
    );
    expect(err!.code).toBe("unreadable_response");
    expect(err!.retryable).toBe(true);
    expect(err!.status).toBe(201);
  });

  it("a draft SAVE whose answer omits the id is the same class — the other arm", async () => {
    // WRITTEN BECAUSE THE FIRST VERSION ONLY REACHED ONE ARM. There are two places that read an id
    // out of a successful create — the autosave path and the send's own create — and a `mail_send`
    // fixture only exercises the second, so mutating the first stayed green.
    const { adapter } = scripted([() => new Response(JSON.stringify({}), {
      status: 201, headers: { "content-type": "application/json" },
    })]);
    const err = await adapter.mutate(
      { kind: "draft_save", draftId: null, mailboxId: "m", subject: "s", body: "b" } as unknown as EngineMutation,
      { idempotencyKey: "k-save-empty" },
    ).then(() => null, (e: unknown) => e as MutationRejectedError);
    expect(err!.code).toBe("unreadable_response");
    expect(err!.retryable).toBe(true);
    expect(err!.status).toBe(201);
  });

  it("an object missing the id it promised is the same class, and never `no draft was made`", async () => {
    const { adapter } = scripted([() => new Response(JSON.stringify({}), {
      status: 201, headers: { "content-type": "application/json" },
    })]);
    const err = await adapter.mutate(SEND, { idempotencyKey: "k-empty" }).then(
      () => null, (e: unknown) => e as MutationRejectedError,
    );
    // The costliest instance: `send_failed` here says no draft was made about one that may have
    // been written AND paid for, and frees the next press to mint a new key.
    expect(err!.code).toBe("unreadable_response");
    expect(err!.retryable).toBe(true);
    expect(err!.status).toBe(201);
  });
});

describe("an unreadable draft create is not repeated", () => {
  it("a second attempt under the same key does NOT issue a second POST /drafts", async () => {
    /**
     * ── ROUND FIVE, FINDING 7 ──────────────────────────────────────────────────────────────
     *
     * `POST /drafts` ignores the idempotency key it is given — the adapter's own comment on the
     * request says so. When its 201 body is truncated, `null`, or missing `id`, the server has
     * committed a draft the client cannot name. The old code reported that retryable with a
     * sentence promising ohmail would "ask again under the same key", and the retry then created
     * a SECOND draft: duplicates accumulating on autosave, and on a send an orphaned first draft
     * with the message going out under the second.
     */
    const posts: string[] = [];
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/drafts")) {
        posts.push(url);
        // Committed server-side, unreadable to the client: 201 with no id.
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = new HttpAdapter({ baseUrl: "https://x.test", fetch: fetchImpl as never });
    const m = {
      kind: "draft_save", draftId: null, mailboxId: "mbx-1", inReplyTo: null,
      subject: "s", body: "b", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation;

    const first = await adapter.mutate(m, { idempotencyKey: "k-1" }).catch((e: Error) => e);
    expect(first).toBeInstanceOf(MutationRejectedError);
    expect((first as MutationRejectedError).code).toBe("unreadable_response");
    expect(posts, "the first attempt did not reach the create route").toHaveLength(1);

    const second = await adapter.mutate(m, { idempotencyKey: "k-1" }).catch((e: Error) => e);
    expect(
      posts,
      "a second draft was created for one the server may already hold — the route ignores the key, "
        + "so nothing on the server collides",
    ).toHaveLength(1);
    expect((second as MutationRejectedError).code).toBe("draft_unverified");
    expect((second as MutationRejectedError).retryable).toBe(false);
  });
});

/**
 * ── THE ROW A SEND IS ABOUT RIDES ITS OWN REFUSAL ───────────────────────────────────────────
 *
 * `MutationResult.entityId` named a row a mutation CREATED and rode the confirmed result alone,
 * on the reasoning that "a row that was refused has no id to adopt". True of every refusal but
 * one, and the exception is the one that costs a second delivery.
 *
 * A press that carries no `draftId` — the compose surface's first send, and every send from the
 * phone — makes the ADAPTER create the row. When the answer is `unverified` the server has marked
 * THAT row, and the client was never told which row it is: it sits in the Drafts list looking like
 * an ordinary draft, opening it takes the ordinary door, and one press delivers the message again.
 * The same holds for a `queued` answer across a reload.
 *
 * NAMED, NOT ADOPTED. Nothing PUTs to the row on the strength of this: it is written onto the
 * durable send record so the message can be recognised as the one this browser is waiting on.
 */
describe("a send's refusal names the row it is about", () => {
  const created = (id: string): Response =>
    new Response(JSON.stringify({ id }), { status: 201 });

  it("`unverified` carries the row the adapter created for the press", async () => {
    const { adapter } = scripted([
      () => created("srv-9"),
      () => new Response(
        JSON.stringify({ status: "unverified", message: "we could not confirm this" }),
        { status: 200 },
      ),
    ]);
    const err = await adapter.mutate(SEND, { idempotencyKey: "k-u1" }).then(
      () => null, (e: unknown) => e as MutationRejectedError,
    );
    expect(err!.code).toBe("send_unverified");
    expect(
      err!.entityId,
      "the row the server marked is not named, so the client cannot tell which draft in its own "
        + "list is the message whose send may already have gone",
    ).toBe("srv-9");
  });

  it("`queued` carries it too — a reload inside that window otherwise mints a second row", async () => {
    const { adapter } = scripted([
      () => created("srv-10"),
      () => new Response(JSON.stringify({ status: "queued" }), { status: 202 }),
    ]);
    const err = await adapter.mutate(SEND, { idempotencyKey: "k-u2" }).then(
      () => null, (e: unknown) => e as MutationRejectedError,
    );
    expect(err!.code).toBe("send_queued");
    expect(err!.entityId, "an accepted send does not name the row it is about").toBe("srv-10");
  });

  it("a send that CARRIED a row names that one, and a refusal about no row names none", async () => {
    /*
     * The two controls. Without the first, the field could be a constant; without the second, a
     * refusal that has no row to speak of would invent one, and an invented row is a park on the
     * wrong message.
     */
    /* TWO STEPS, because a send that carries a row PUTs it first — a one-step script hands the
       PUT the send's answer and the case then fails for a reason that is not the product's. */
    const withRow = scripted([
      /* The PUT's echo has to be a DTO the adapter accepts — it checks the sending address and
         the Bcc array came back — or the send is refused before it is ever made and the case
         measures the guard beside the one it is about. */
      () => new Response(
        JSON.stringify({ id: "mine-1", bcc: [], mailboxId: "mbx-1" }),
        { status: 200 },
      ),
      () => new Response(JSON.stringify({ status: "unverified" }), { status: 200 }),
    ]);
    const errWithRow = await withRow.adapter.mutate(
      { ...(SEND as object), draftId: "mine-1" } as unknown as EngineMutation,
      { idempotencyKey: "k-u3" },
    ).then(() => null, (e: unknown) => e as MutationRejectedError);
    expect(errWithRow!.entityId, "the row the press carried is not the row named").toBe("mine-1");

    const noRow = scripted([() => new Response("{", { status: 201 })]);
    const errNoRow = await noRow.adapter.mutate(SEND, { idempotencyKey: "k-u4" }).then(
      () => null, (e: unknown) => e as MutationRejectedError,
    );
    expect(errNoRow!.code).toBe("unreadable_response");
    expect(
      errNoRow!.entityId,
      "a refusal about a row that was never readable named one anyway — a park on a row this "
        + "client invented is a park on the wrong message",
    ).toBeNull();
  });

  it("the ENGINE carries it out on the queued result, where the caller reads it", async () => {
    /*
     * The adapter throws; the engine turns a retryable refusal into `{status:"queued"}`. The row
     * has to survive that translation or naming it in the adapter buys nothing.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-entityid", factory });
    const engine = new OhmailEngine({
      store,
      adapter: failing(
        new FixturesAdapter(),
        () => new MutationRejectedError("accepted, still handing over", {
          status: 202, code: "send_queued", retryable: true, entityId: "srv-11",
        }),
      ),
    });
    await engine.start();
    const res = await engine.mutate(SEND);
    expect(res.status, "the retryable refusal did not queue").toBe("queued");
    expect(
      res.entityId,
      "the row an accepted send is about is dropped between the adapter and the caller, so the "
        + "durable record cannot name it and a reload mints a second row for one message",
    ).toBe("srv-11");
  });
});

describe("the unreadable-create refusal outlives the adapter that made it", () => {
  it("a REPLAY through a fresh adapter does not create a second draft", async () => {
    /**
     * ── ROUND SIX, FINDING 9 ───────────────────────────────────────────────────────────────
     *
     * The guard was a `Set` on the adapter instance. A reload builds a new adapter with an empty
     * one, and the durable outbox replays the entry under its original key — so `POST /drafts`,
     * which ignores that key, wrote the second draft the guard exists to prevent. The refusal is
     * a fact about the INTENT, so it is persisted with it and handed back on every later attempt.
     */
    const posts: string[] = [];
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/drafts")) {
        posts.push(url);
        // Committed server-side, unreadable to the client: 201 with no id.
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ items: [], cursor: null, hasMore: false }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const m = {
      kind: "draft_save", draftId: null, mailboxId: "mbx-1", inReplyTo: null,
      subject: "s", body: "b", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation;
    const now = () => new Date(Date.parse("2026-09-08T11:00:00.000Z"));
    const factory = new IDBFactory();

    const store = new IndexedDbMirrorStore({ owner: "acct-create-replay", factory });
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "https://x.test", fetch: fetchImpl as never }) as never,
      store, now,
    } as never);
    await engine.start().catch(() => undefined);
    await engine.mutate(m).catch(() => undefined);
    expect(posts, "the create never went out, so this case measures nothing").toHaveLength(1);
    store.close();

    // The reload: a fresh adapter with no memory of the attempt, over the same database.
    const store2 = new IndexedDbMirrorStore({ owner: "acct-create-replay", factory });
    const engine2 = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "https://x.test", fetch: fetchImpl as never }) as never,
      store: store2, now,
    } as never);
    await engine2.hydrate();
    await engine2.syncOnce().catch(() => undefined);
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => { setTimeout(r, 5); });
    expect(
      posts,
      "the replay issued a second POST /drafts — the route ignores the key, so the server now "
        + "holds two rows for one message the person asked for once",
    ).toHaveLength(1);
    store2.close();
  });
});

/**
 * THE SEND TWIN OF THE SAME ROUTE. A send pressed before the first autosave creates the row
 * itself, so it carries the identical hazard and the identical two lines — asked here directly,
 * because the engine half is already proved by the replay case above.
 */
describe("a remembered create refusal is honoured by an adapter that never made it", () => {
  it("a send whose intent says the create already went out does not POST /drafts again", async () => {
    const posts: string[] = [];
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/drafts")) {
        posts.push(url);
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = new HttpAdapter({ baseUrl: "https://x.test", fetch: fetchImpl as never });
    const err = await adapter.mutate(SEND, { idempotencyKey: "k-send-known", createAttempted: true })
      .then(() => null, (e: unknown) => e as MutationRejectedError);
    expect(posts, "the adapter created a second draft for a create it was told had gone out").toEqual([]);
    expect(err!.code).toBe("draft_unverified");
  });
});
