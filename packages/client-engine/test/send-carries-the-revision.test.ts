import { describe, expect, it } from "vitest";
import {
  HttpAdapter, MutationRejectedError,
  type EngineMutation, type FetchLike,
} from "../src/index.js";

/**
 * ═══ THE SEND NAMES THE ROW VERSION IT WAS COMPOSED AGAINST ════════════════════════════════
 *
 * The send is two requests: a PUT that writes the message on screen, then a POST that sends the
 * ROW. Between them another window's autosave can commit, and the POST would deliver that
 * window's recipients and words. So the PUT's answer names the row's version and the POST carries
 * it back; the server refuses a row that has moved off it.
 *
 * The version is READ FROM THE SERVER and never computed here — one implementation of the
 * canonicalization, so a client and a server cannot drift into refusing every send.
 */
interface Call { method: string; url: string; body: Record<string, unknown>; echo?: string | null }

/** The three answers a send makes, recorded. `revision` is what the row's DTO reports. */
function harness(over: { revision?: string | null; createRevision?: string | null } = {}) {
  const calls: Call[] = [];
  const rev = over.revision === undefined ? "a".repeat(64) : over.revision;
  const createRev = over.createRevision === undefined ? "c".repeat(64) : over.createRevision;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url, "http://localhost").pathname;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* not json */ } }
    calls.push({ method: init?.method ?? "GET", url, body, echo: new Headers(init?.headers as HeadersInit).get("x-ohmail-echo") });

    if (path === "/drafts" && init?.method === "POST") {
      return new Response(JSON.stringify({
        id: "draft-created", bcc: [], mailboxId: "mbx-1",
        ...(createRev === null ? {} : { contentRevision: createRev }),
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (path.startsWith("/drafts/") && init?.method === "PUT") {
      return new Response(JSON.stringify({
        id: "draft-1", bcc: [], mailboxId: "mbx-1",
        ...(rev === null ? {} : { contentRevision: rev }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.endsWith("/send")) {
      return new Response(JSON.stringify({ status: "sent", providerMessageId: "<id@x>" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const mutation = (draftId?: string): EngineMutation => ({
  kind: "mail_send",
  mailboxId: "mbx-1",
  inReplyTo: null,
  subject: "the invoice",
  body: "Here is the invoice you asked for.",
  to: [{ name: null, address: "chosen@example.com" }],
  ...(draftId ? { draftId } : {}),
} as EngineMutation);

const sendBodyOf = (calls: Call[]): Record<string, unknown> =>
  calls.find((c) => c.url.endsWith("/send"))?.body ?? {};

describe("a send carries the draft version its own PUT returned", () => {
  it("puts the PUT's revision on the send", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    await a.mutate(mutation("draft-1"), { idempotencyKey: "k1" });

    expect(sendBodyOf(calls).ifContentRevision).toBe("a".repeat(64));
  });

  it("carries the CREATED row's revision when the press brought no row of its own", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    await a.mutate(mutation(), { idempotencyKey: "k2" });

    expect(sendBodyOf(calls).ifContentRevision).toBe("c".repeat(64));
  });

  /**
   * A server that predates the field echoes none, and this client still sends. The alternative is
   * an install that cannot send its own mail against an older API, which is a worse failure than
   * the window this closes.
   */
  it("sends with no revision against a server that names none", async () => {
    const { calls, fetchImpl } = harness({ revision: null });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    await a.mutate(mutation("draft-1"), { idempotencyKey: "k3" });

    expect(calls.some((c) => c.url.endsWith("/send")), "the send never left").toBe(true);
    expect(sendBodyOf(calls).ifContentRevision).toBeUndefined();
  });

  it("asks the door to answer before its copy echoes only where the host opted in", async () => {
    const plain = harness();
    await new HttpAdapter({ baseUrl: "http://localhost", fetch: plain.fetchImpl }).mutate(mutation("draft-1"), { idempotencyKey: "k5" });
    await new HttpAdapter({ baseUrl: "http://localhost", fetch: plain.fetchImpl }).mutate(mutation(), { idempotencyKey: "k6" });
    expect(plain.calls.map((c) => c.echo), "a default adapter marked a send").toEqual(plain.calls.map(() => null));
    const later = harness();
    await new HttpAdapter({ baseUrl: "http://localhost", fetch: later.fetchImpl, sendEchoLater: true }).mutate(mutation("draft-1"), { idempotencyKey: "k7" });
    expect(later.calls.map((c) => `${c.method} ${c.echo}`)).toEqual(["PUT later", "POST later"]);
  });

  /**
   * THE SERVER'S REFUSAL REACHES THE SURFACE AS ITS OWN CODE, not as a retryable in-flight
   * answer: a `draft_changed` that came back retryable would be replayed by the outbox for ever
   * against a row that has moved, and the person would never be asked to look.
   */
  it("relays a refused send as draft_changed, terminal", async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url, "http://localhost").pathname;
      calls.push({ method: init?.method ?? "GET", url, body: {} });
      if (path.startsWith("/drafts/") && init?.method === "PUT") {
        return new Response(JSON.stringify({ id: "draft-1", bcc: [], mailboxId: "mbx-1", contentRevision: "b".repeat(64) }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path.endsWith("/send")) {
        return new Response(JSON.stringify({
          error: { code: "draft_changed", message: "This draft changed in another window. Review it before sending." },
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    const err = await a.mutate(mutation("draft-1"), { idempotencyKey: "k4" })
      .then(() => null)
      .catch((e: unknown) => e as MutationRejectedError);

    expect(err, "a refused send resolved as though it had gone").not.toBeNull();
    expect(err!.code).toBe("draft_changed");
    expect(err!.retryable).toBe(false);
  });
});
