import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { HttpAdapter, type FetchLike } from "../src/index.js";

/**
 * ═══ THE SERIALIZER'S HALF OF `firstSend` ═══════════════════════════════════════════════════
 * The middle of the field's three homes: the answer's admitted shape, this parser, and the
 * surface that says the sentence. A field that stops here is a server telling the truth to
 * nobody. Shape-checked rather than forwarded — what arrives becomes a statement about
 * somebody's mail on a screen, and absence is the only other state.
 * Mutations: the parse dropped → 1; the wire value forwarded unchecked → 3, 4; the field put on
 * every send → 2.
 */
interface Call { path: string }

function harness(firstSend: unknown, sentDraftId?: string) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url, "http://localhost").pathname;
    calls.push({ path });
    if (path.startsWith("/drafts/") && init?.method === "PUT") {
      return new Response(JSON.stringify({ id: "draft-1", bcc: [], mailboxId: "mbx-1", contentRevision: "a".repeat(64) }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.endsWith("/send")) {
      return new Response(JSON.stringify({
        status: "sent", providerMessageId: "<id@x>",
        ...(firstSend === undefined ? {} : { firstSend }),
        ...(sentDraftId === undefined ? {} : { sentDraftId, sentDraftThrough: 7 }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const press = (): EngineMutation => ({
  kind: "mail_send", inReplyTo: "msg-1", draftId: "draft-1", subject: "Re: the invoice",
  body: "the numbers are attached",
} as unknown as EngineMutation);

const outcomeFor = async (firstSend: unknown, key: string, sentDraftId?: string) => {
  const { fetchImpl } = harness(firstSend, sentDraftId);
  const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
  const answer = await a.mutate(press(), { idempotencyKey: key });
  // A send the server answered is an OUTCOME, never the queued-for-somebody-else form. Narrowed
  // on the union's own discriminant rather than cast, so a change to it is a compile error here
  // instead of a field that silently reads `undefined` and greens every case below.
  if ("settlement" in answer) throw new Error("the send was queued for another install, not answered");
  return answer;
};

describe("a send answered from an earlier reservation reaches the surface", () => {
  it("1 — the server's statement is carried on the outcome", async () => {
    const out = await outcomeFor({ status: "sent", at: "2026-09-16T07:00:00.000Z" }, "k-1");
    expect(out.firstSend).toEqual({ status: "sent", at: "2026-09-16T07:00:00.000Z" });
    expect(out.sentDraftId).toBeUndefined();
  });

  it("2 — an ordinary send carries none, so nothing is said about it", async () => {
    const out = await outcomeFor(undefined, "k-2");
    expect(out.firstSend ?? null).toBeNull();
    expect(out.sentDraftId).toBeUndefined();
  });

  it("takes the delivered draft from the answer when a key settled another draft", async () => {
    const out = await outcomeFor(undefined, "replayed", "delivered-draft");
    expect(out.sentDraftId).toBe("delivered-draft");
    expect(out.sentDraftThrough).toBe(7);
  });

  /**
   * A value that is not the shape is not a fact. Forwarding it would put `undefined` — or a
   * number, or an object — where a surface renders an instant a person is told to go and check.
   */
  it("3 — a half-built value is dropped rather than forwarded", async () => {
    expect((await outcomeFor({ status: "sent" }, "k-3")).firstSend ?? null).toBeNull();
    expect((await outcomeFor({ at: "2026-09-16T07:00:00.000Z" }, "k-4")).firstSend ?? null).toBeNull();
  });

  it("4 — and so is a value of the wrong types", async () => {
    expect((await outcomeFor({ status: 1, at: 2 }, "k-5")).firstSend ?? null).toBeNull();
    expect((await outcomeFor("sent", "k-6")).firstSend ?? null).toBeNull();
  });
});
