import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_TYPE,
  type EngineAdapter,
  type EngineMutation,
  type FetchLike,
} from "@ohmail/client-engine";
import { FixturesAdapter, DEMO_NOW } from "@ohmail/testing/adapter";
import { classifyRefusal, UNJUDGED_WRITE_CODES } from "../src/adapters/refusal-shape.js";

/**
 * AN ANSWER NOBODY JUDGED A WRITE WITH NEVER RETIRES IT. The desktop engine answers a write it
 * could not send — offline, or with no session to send it in — and neither is the server's
 * verdict. One closed set says which codes those are, and the two readers below hold to it on
 * their own: the refusal reader, whatever the envelope says, and the engine's belt for a
 * rejection built by hand.
 */
describe("the answers nobody judged a write with", () => {
  it("are exactly two: offline, and no session to send it in", () => {
    expect([...UNJUDGED_WRITE_CODES].sort()).toEqual(["not_signed_in", "offline_read_only"]);
  });

  it("a write answered with one is retryable whatever the envelope and the status say", () => {
    for (const code of ["offline_read_only", "not_signed_in"]) {
      for (const status of [409, 503]) {
        expect(classifyRefusal(status, { code }, "write"), `${status} ${code}`).toEqual({ code, retryable: true });
        expect(classifyRefusal(status, { code, retryable: false }, "write"), `${status} ${code}, said not retryable`)
          .toEqual({ code, retryable: true });
      }
    }
  });

  it("control: a read keeps the envelope's word, and no other 409 is widened", () => {
    expect(classifyRefusal(409, { code: "not_signed_in" }, "read")).toEqual({ code: "not_signed_in", retryable: false });
    for (const code of ["handoff_not_available", "outbox_scope_mismatch", "send_in_flight", "duplicate_send", "conflict"]) {
      expect(classifyRefusal(409, { code }, "write"), code).toEqual({ code, retryable: false });
    }
    expect(classifyRefusal(409, { code: "mailbox_not_signed_in" }, "write").retryable, "a near spelling").toBe(false);
  });
});

describe("the engine keeps a write a hand-built rejection says nobody judged", () => {
  function engineRefusing(error: () => Error) {
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (params) => inner.sync(params),
      mutate: async () => { throw error(); },
    };
    const store = new MemoryMirrorStore();
    return { engine: new OhmailEngine({ adapter, store, now: () => DEMO_NOW }), store };
  }
  const VERB: EngineMutation = { kind: "mark_seen", messageIds: ["giulia"], unread: false };

  it("a 409 not_signed_in built as not retryable is queued, and its durable row stays", async () => {
    const { engine, store } = engineRefusing(() => new MutationRejectedError("not signed in", {
      status: 409, code: "not_signed_in", retryable: false,
    }));
    await engine.start();
    const res = await engine.mutate(VERB);
    expect(res.status, "the write was dropped as refused").toBe("queued");
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(1);
    expect(engine.pendingMutations()).toHaveLength(1);
  });

  it("control: a refusal with any other code, built the same way, is still a refusal", async () => {
    const { engine, store } = engineRefusing(() => new MutationRejectedError("conflict", {
      status: 409, code: "conflict", retryable: false,
    }));
    await engine.start();
    expect((await engine.mutate(VERB)).status).toBe("rolled_back");
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(0);
  });
});

describe("the send route builds its refusal by the same rule", () => {
  /** A send to a draft row: the row's PUT is answered, the send itself with `answer`. */
  const sending = (status: number, error: Record<string, unknown>) => {
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url, "http://localhost").pathname;
      if (path.startsWith("/drafts/") && init?.method === "PUT") {
        return new Response(JSON.stringify({ id: "draft-1", bcc: [], mailboxId: "mbx-1", contentRevision: "a".repeat(64) }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path.endsWith("/send")) {
        return new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    const press = {
      kind: "mail_send", inReplyTo: "msg-1", draftId: "draft-1", subject: "Re: the invoice", body: "the numbers",
    } as unknown as EngineMutation;
    return adapter.mutate(press, { idempotencyKey: "k-send-1" }).then(() => null, (e: unknown) => e);
  };

  it("a send answered not_signed_in with no retryable is kept, never refused", async () => {
    const err = await sending(409, { code: "not_signed_in", message: "not signed in" });
    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).code).toBe("not_signed_in");
    expect((err as MutationRejectedError).retryable, "the send route read the signed-out answer as a refusal").toBe(true);
  });

  it("control: another 409 the send route builds the same way is still a refusal", async () => {
    const err = await sending(409, { code: "conflict", message: "no" });
    expect(err).toBeInstanceOf(MutationRejectedError);
    expect((err as MutationRejectedError).retryable).toBe(false);
  });
});
