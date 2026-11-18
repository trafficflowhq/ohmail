import type { MessageDTO, SyncChange, SyncResponse, ThreadDTO } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE ENGINE NAMES A DEAD SESSION instead of serving a silently frozen mirror behind it.
 *
 * The measured failure, live on a paired desktop: its refresh family was revoked server-side
 * (refresh-token reuse detection — by design, and it tells nobody), after which the mirror's
 * every pull failed 401 → refresh 401 → backoff, every five minutes, for a day — while the
 * window rendered week-old mail with no notice anywhere. The person in front of it reported
 * "sync is broken", because nothing could say "you are signed out".
 *
 * The contract under test: a DEFINITIVE refresh refusal (401/403) tears the engine down to its
 * pre-auth state — `/health` says `signedIn: false` with `sessionExpired: true`, so the shell
 * renders the sign-in surface and can word it as an ended session — while the local reads keep
 * serving what the mirror holds (signing out never deletes mail).
 */

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOX = hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test");
const iso = (): string => new Date().toISOString();

function messageDTO(id: string, threadId: string): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject: "Can we talk?",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "we have not met before", unread: true,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
function threadDTO(id: string): ThreadDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, subject: "Can we talk?", messageIds: [],
    participants: [{ name: null, address: "stranger@nowhere.test" }],
    lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
  };
}
function syncPage(changes: SyncChange[], cursor: string, hasMore: boolean): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: changes.filter((c) => c.op === "move"),
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore, serverTime: iso(),
  };
}
const change = (type: SyncChange["type"], id: string, op: SyncChange["op"], seq: number, entity?: unknown): SyncChange =>
  ({ type, op, id, seq, updatedAt: iso(), ...(entity !== undefined ? { entity } : {}) });

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a definitive refresh refusal returns the engine to sign-in", () => {
  it("flips /health to signedIn:false + sessionExpired:true, and the mirror keeps serving", { timeout: 30_000 }, async () => {
    const threadId = randomUUID();
    const msgId = randomUUID();
    let revoked = false;
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw);
      const send = (v: unknown): Response =>
        new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (revoked) {
        // The whole hosted API after a family revocation: every bearer answers 401 and the
        // refresh itself is refused — exactly what reuse detection leaves behind.
        return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      }
      if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
      if (url.pathname === "/sync") {
        const since = url.searchParams.get("since") ?? "0";
        if (since === "0") {
          return send(syncPage([
            change("thread", threadId, "create", 1, threadDTO(threadId)),
            change("message", msgId, "create", 2, messageDTO(msgId, threadId)),
          ], Buffer.from("2").toString("base64url"), false));
        }
        return send(syncPage([], since, false));
      }
      if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const dataDir = await freshDataDir("ohmail-session-expiry-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 40, // fast poll so the post-revocation pull happens inside the test
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    const health = async (): Promise<{ signedIn: boolean; sessionExpired: boolean }> =>
      (await sidecar.handle(new Request("http://sidecar/health"))).json() as never;
    expect(await health()).toMatchObject({ signedIn: true, sessionExpired: false });

    // ── The family dies server-side. The next poll's refresh is refused for good. ──
    revoked = true;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const h = await health();
      if (h.sessionExpired) {
        expect(h.signedIn, "an expired session cannot claim to be signed in").toBe(false);
        break;
      }
      if (Date.now() > deadline) throw new Error("the engine never noticed the dead session");
      await new Promise((r) => setTimeout(r, 25));
    }

    // The read surface now answers the SIGNED-OUT refusal — the window lands on the sign-in
    // surface instead of rendering a silently frozen mailbox behind a dead session. (The mirror's
    // rows stay on disk untouched — sign-out freezes the directory, it never deletes mail — and a
    // later sign-in serves them again; `cloud-engine.ts`'s signOut header carries that rule.)
    const list = await sidecar.handle(new Request("http://sidecar/messages?view=imbox", { headers: auth }));
    expect(list.status, "a signed-out engine must refuse the mailbox read, not serve stale mail as live").toBe(409);
  });
});
