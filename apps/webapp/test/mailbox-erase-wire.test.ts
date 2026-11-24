/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.NEXT_PUBLIC_API_BASE = "/api";
const { mailboxes, profileImport, ApiError } = await import("../app/api-client");
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";

/**
 * THE ERASE DOOR ON THE WIRE — the real client, a stubbed `fetch`. The pane's test mocks the
 * client, so this is where `?erase=1` with the typed address in the BODY is held: the address
 * travels exactly as typed (the server compares it, trimmed and case-folded, with the row) and
 * never in the URL, and the removal that keeps the copy sends no erase flag at all.
 */

let calls: Array<{ url: string; method: string; body?: string }> = [];
/** The fingerprint header each request carried, in order (absent: null). */
let fingerprintHeaders: Array<string | null> = [];
let answer: () => Response = () => new Response(null, { status: 204 });
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  fingerprintHeaders = [];
  document.cookie = `${OWNER_COOKIE}=acct-one`;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url), method: String(init?.method ?? "GET"),
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    });
    fingerprintHeaders.push(new Headers(init?.headers).get("x-ohmail-profile-fingerprint"));
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("mailboxes.erase and mailboxes.remove, as requests", () => {
  it("the erase is a DELETE carrying erase=1, with the typed address in the body and not the URL", async () => {
    answer = () => new Response(JSON.stringify({
      erasing: true, mailboxId: "mb1", messages: 3000, drafts: 1, draftsUnanchored: 0, retained: "",
    }), { status: 202, headers: { "content-type": "application/json" } });
    const receipt = await mailboxes.erase("mb1", " Person+tag@Example.test ");
    expect(calls).toEqual([{
      url: "/api/mailboxes/mb1?erase=1", method: "DELETE",
      body: JSON.stringify({ confirm: " Person+tag@Example.test " }),
    }]);
    expect(receipt).toMatchObject({ erasing: true, mailboxId: "mb1", messages: 3000 });
  });

  it("POSITIVE CONTROL: the removal that keeps the copy is the bare DELETE", async () => {
    await mailboxes.remove("mb1");
    expect(calls).toEqual([{ url: "/api/mailboxes/mb1", method: "DELETE" }]);
  });
});

describe("profileImport.status, as a request: the settings fingerprint is never in the URL", () => {
  const FP = "f".repeat(64);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });

  it("asks with the fingerprint in a header and a bare path", async () => {
    answer = () => json(200, { state: "importing", fingerprint: FP });
    expect(await profileImport.status("mb1", FP)).toEqual({ state: "importing", fingerprint: FP });
    expect(calls).toEqual([{ url: "/api/mailboxes/mb1/profile-import/status", method: "GET" }]);
    expect(fingerprintHeaders).toEqual([FP]);
  });

  it("an older server that cannot read the header (400 validation_failed) is asked once more by query", async () => {
    let n = 0;
    answer = () => (n++ === 0
      ? json(400, { error: { code: "validation_failed", message: "fingerprint is required" } })
      : json(200, { state: "refused", reason: "superseded", message: "Another import replaced this one." }));
    expect(await profileImport.status("mb1", FP)).toMatchObject({ state: "refused", reason: "superseded" });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/mailboxes/mb1/profile-import/status",
      `/api/mailboxes/mb1/profile-import/status?fingerprint=${FP}`,
    ]);
    expect(fingerprintHeaders).toEqual([FP, null]);
  });

  it("any other refusal is the answer: no second ask", async () => {
    answer = () => json(404, { error: { code: "not_found", message: "mailbox not found" } });
    const err = await profileImport.status("mb1", FP).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });
});
