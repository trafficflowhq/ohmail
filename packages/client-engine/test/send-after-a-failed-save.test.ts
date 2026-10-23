import { describe, expect, it } from "vitest";
import {
  HttpAdapter, MutationRejectedError,
  type EngineMutation, type FetchLike,
} from "../src/index.js";

/**
 * ═══ A SEND WHOSE OWN SAVE FAILED VOUCHES FOR THE VERSION IT LAST SAW ══════════════════════
 * The send's PUT may fail, and when it did this client carried NO version — so the route read
 * whatever row it found and the other window's words could leave under that press. The save's
 * answer is now remembered per draft and a failed PUT carries the last version this client was
 * SHOWN; never a fresh read, which would vouch for text nobody here has looked at. With nothing
 * observed at all the PUT is repeated once and the press is refused.
 * Mutations: the failed-save arm deleted → 1, 2, 5; the fallback re-reading the row → 1; the
 * repeat removed → 2, 3; the repeat armed on every failure → 6; the bound made dead → 5.
 */
interface Call { method: string; path: string; body: Record<string, unknown> }

/** What the row is at NOW on the server — what a fresh read would return, and must not be carried. */
const SERVER_NOW = "9".repeat(64);
const SAVED = "a".repeat(64);

/**
 * One account, one server. `putFails` is the blipped save: the request is recorded and rejected
 * exactly as a dropped connection rejects, which is the class the adapter's own catch handles.
 */
function harness(opts: { putFails?: () => boolean; putRevision?: string | null; putRefusal?: () => Response | null } = {}) {
  const calls: Call[] = [];
  const putFails = opts.putFails ?? (() => false);
  const rev = opts.putRevision === undefined ? SAVED : opts.putRevision;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url, "http://localhost").pathname;
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* not json */ } }
    calls.push({ method: init?.method ?? "GET", path, body });

    if (path.endsWith("/send")) {
      return new Response(JSON.stringify({ status: "sent", providerMessageId: "<id@x>" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (path.startsWith("/drafts/") && init?.method === "PUT") {
      if (putFails()) throw new TypeError("Network request failed");
      const refused = opts.putRefusal?.() ?? null;
      if (refused) return refused;
      return new Response(JSON.stringify({
        id: path.split("/")[2], bcc: [], mailboxId: "mbx-1",
        ...(rev === null ? {} : { contentRevision: rev }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // A READ of the row — the thing the fallback may never do. It answers the CURRENT version,
    // so a fix that re-reads is visible in the value the send carries and not only in this log.
    if (path.startsWith("/drafts/") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ id: path.split("/")[2], contentRevision: SERVER_NOW }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

/** The autosave — a plain reply's, which is the press that reaches the gap (no Bcc, no From pick). */
const save = (draftId: string, text: string): EngineMutation => ({
  kind: "draft_save", draftId, mailboxId: "mbx-1", threadId: null, inReplyToMessageId: "msg-1",
  subject: "Re: the invoice", body: text, to: [], cc: [], bcc: [],
} as unknown as EngineMutation);

/** The press. No `mailboxId`: a reply leaves the sender to `enrich`, which is why the From guard
 *  above it does not fire and this is the send that used to go out vouching for nothing. */
const press = (draftId: string, text: string): EngineMutation => ({
  kind: "mail_send", inReplyTo: "msg-1", draftId, subject: "Re: the invoice", body: text,
} as unknown as EngineMutation);

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");
const sends = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/send"));
const reads = (calls: Call[]) => calls.filter((c) => c.method === "GET");

describe("a send whose own save failed carries the version this client last saw", () => {
  it("1 — the autosave's version goes on the send, and nothing is re-read", async () => {
    let failing = false;
    const { calls, fetchImpl } = harness({ putFails: () => failing });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });

    // The composer autosaved while the person wrote: this client was SHOWN `SAVED`.
    await a.mutate(save("draft-1", "the numbers are attached"), { idempotencyKey: "save-1" });
    // …and then the network blipped under Send's own PUT.
    failing = true;
    await a.mutate(press("draft-1", "the numbers are attached"), { idempotencyKey: "send-1" });

    expect(sends(calls), "the send did not leave").toHaveLength(1);
    expect(
      { vouched: sends(calls)[0]!.body.ifContentRevision, readsMade: reads(calls).length },
      "the press vouched for nothing, or for a version nobody on this screen had seen",
    ).toEqual({ vouched: SAVED, readsMade: 0 });
  });

  it("2 — with no version ever observed, the save is repeated once and then the press is refused", async () => {
    const { calls, fetchImpl } = harness({ putFails: () => true });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });

    const err = await a.mutate(press("draft-2", "sending blind"), { idempotencyKey: "send-2" })
      .then(() => null)
      .catch((e: unknown) => e as MutationRejectedError);

    expect(err, "a press that could vouch for nothing was admitted").not.toBeNull();
    expect(
      { code: err!.code, retryable: err!.retryable, puts: puts(calls).length, sends: sends(calls).length },
      "the refusal, the single repeat, or the fact that nothing left",
    ).toEqual({ code: "draft_unsaved", retryable: false, puts: 2, sends: 0 });
  });

  it("3 — the repeat that succeeds sends, carrying what IT answered", async () => {
    let attempts = 0;
    const { calls, fetchImpl } = harness({ putFails: () => ++attempts === 1 });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });

    await a.mutate(press("draft-3", "second time lucky"), { idempotencyKey: "send-3" });

    expect(
      { puts: puts(calls).length, vouched: sends(calls)[0]?.body.ifContentRevision },
      "the repeat never happened, or its answer was thrown away",
    ).toEqual({ puts: 2, vouched: SAVED });
  });

  it("4 — a server that names no version is unaffected: the save answers, and the send goes unstated", async () => {
    const { calls, fetchImpl } = harness({ putRevision: null });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });

    await a.mutate(press("draft-4", "against an older API"), { idempotencyKey: "send-4" });

    expect(
      { puts: puts(calls).length, sends: sends(calls).length, vouched: sends(calls)[0]?.body.ifContentRevision },
      "an install was locked out of its own mail by a field its server has never heard of",
    ).toEqual({ puts: 1, sends: 1, vouched: undefined });
  });

  it("5 — the memory is bounded: the oldest draft's version is dropped and its press refuses", async () => {
    let failing = false;
    const { calls, fetchImpl } = harness({ putFails: () => failing });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });

    // 65 drafts saved — one past the cap — so the first one's version is gone.
    for (let i = 0; i < 65; i++) {
      await a.mutate(save(`row-${i}`, "x"), { idempotencyKey: `save-b-${i}` });
    }
    failing = true;
    const err = await a.mutate(press("row-0", "the oldest"), { idempotencyKey: "send-5a" })
      .then(() => null).catch((e: unknown) => e as MutationRejectedError);
    // …and the newest is still there, which is what makes the cap a cap and not a leak.
    await a.mutate(press("row-64", "the newest"), { idempotencyKey: "send-5b" });

    expect(
      { evicted: err?.code ?? null, kept: sends(calls).at(-1)!.body.ifContentRevision },
      "the map grew without bound, or the cap ate a row still in front of somebody",
    ).toEqual({ evicted: "draft_unsaved", kept: SAVED });
  });

  it("6 — a blipped save over a remembered row does NOT repeat itself", async () => {
    let failing = false;
    const { calls, fetchImpl } = harness({ putFails: () => failing });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    await a.mutate(save("draft-6", "saved once"), { idempotencyKey: "save-6" });
    const before = puts(calls).length;

    failing = true;
    await a.mutate(press("draft-6", "saved once"), { idempotencyKey: "send-6" });

    expect(
      puts(calls).length - before,
      "the repeat fired for a press that already had something to vouch with",
    ).toBe(1);
  });

  it("7 — a first press whose save is refused for its own words sends nothing and says that refusal", async () => {
    let refuse = false;
    const { calls, fetchImpl } = harness({
      putRefusal: () => refuse
        ? new Response(JSON.stringify({ error: { code: "draft_too_large", message: "Too large." } }), {
          status: 413, headers: { "content-type": "application/json" },
        })
        : null,
    });
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    // Saved once under the limit, so the older row is what a send would deliver.
    await a.mutate(save("draft-7", "short"), { idempotencyKey: "save-7" });
    const before = puts(calls).length;

    refuse = true;
    const err = await a.mutate(press("draft-7", "far too long"), { idempotencyKey: "send-7" })
      .then(() => null).catch((e: unknown) => e as MutationRejectedError);

    expect(
      {
        code: err?.code ?? null, retryable: err?.retryable ?? null, entityId: err?.entityId ?? null,
        puts: puts(calls).length - before, sends: sends(calls).length,
      },
      "the older row was sent, the PUT repeated, or the refusal lost its code",
    ).toEqual({ code: "draft_too_large", retryable: false, entityId: "draft-7", puts: 1, sends: 0 });
  });
});
