import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessageBodyBatchItem, MessageDTO, Page, SyncChange, SyncResponse, ThreadDTO,
} from "@trafficflow/services/mail";
import {
  createCloudSidecar, readMirrorBase, readMirrorOwner, type CloudSidecar,
} from "../../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshDataDir } from "../_datadir.js";

/**
 * ONE MIRROR, ONE ACCOUNT — ASKED AT EVERY SESSION, NOT ONLY AT EVERY LAUNCH.
 *
 * `mirror-owner.test.ts` drives `enforceMirrorOwner` on disk and proves the DISCARD. This file
 * drives the other half, which is the one that was missing: a running engine that has been signed
 * OUT still holds the previous account's database, cursor and world, because `signOut` freezes them
 * deliberately — nothing can be read while there is no session, and throwing a mirror away buys a
 * full re-pull and nothing else. That freeze is correct, and it is exactly what makes the next
 * sign-in the moment where account isolation is decided.
 *
 * The shape being refused, end to end and on real files:
 *
 *   1. account A signs in; the mirror fills with A's mail under the single local `accounts` row;
 *   2. A signs out — the mail, the cursor and the mirror-owner marker stay where they are;
 *   3. somebody signs in with account B's credentials, over the same bridge, into the same process.
 *
 * Before this guard, step 3 answered `signed_in` and B's window read A's mail: the engine is not
 * replaced by a sign-in, so `enforceMirrorOwner` never ran again, and every read dispatches through
 * the LOCAL account id — which is still A's. The assertions below are therefore written against
 * READS and not against `signedIn()`: a flag saying the right thing while `GET /messages/:id`
 * serves the previous account's message would be exactly the failure, reported as a pass.
 *
 * ── THE MUTATION THAT MUST TURN THIS FILE RED ────────────────────────────────────────────────
 *
 * Delete the `mirror_owner_mismatch` branch in `cloud-engine.ts` (or make its comparison always
 * agree) and "a foreign sign-in is refused" fails with the sign-in answering 200 — and the read of
 * A's message id, which is the assertion that matters, comes back 200 with A's subject in it.
 *
 * ── AND THE IDENTITY IS NOT TAKEN FROM THE CALLER ────────────────────────────────────────────
 *
 * Every sign-in below sends the address it is signing in AS. That field is an input — the browser
 * handoff sends no address at all — so the fake hosted service answers `GET /auth/session` from its
 * OWN idea of who the pair belongs to, and one of the cases deliberately sends A's address with B's
 * session behind it. A guard reading `body.email` passes that case and is not a guard.
 */

const iso = (): string => new Date().toISOString();
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const A = "first@ohmail.test";
const B = "second@ohmail.test";

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const d = await freshDataDir("ohmail-mirror-signin-");
  dirs.push(d);
  return d;
}

const aKek = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** Every byte under a directory, recursively. The measure of "was this cache thrown away". */
function bytesUnder(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? bytesUnder(path) : statSync(path).size;
  }
  return total;
}

function messageDTO(id: string, threadId: string, subject: string): MessageDTO {
  return {
    id, accountId: ACCOUNT, mailboxId: MAILBOX, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject,
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: A }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "the previous account's mail", unread: true,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
function threadDTO(id: string, subject: string): ThreadDTO {
  return {
    id, accountId: ACCOUNT, subject, messageIds: [],
    participants: [{ name: null, address: "stranger@nowhere.test" }],
    lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
  };
}
function syncPage(changes: SyncChange[], cursor: string): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: changes.filter((c) => c.op === "move"),
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore: false, serverTime: iso(),
  };
}
const change = (type: SyncChange["type"], id: string, seq: number, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq, updatedAt: iso(), entity });

interface Hosted {
  fetchImpl: typeof fetch;
  /** Whose account the NEXT minted pair belongs to. The hosted service's own answer, not a claim. */
  identity: { address: string };
  /** Set to make `GET /auth/session` unanswerable — the fail-closed case. */
  identityDown: { yes: boolean };
  calls: string[];
  /** The one message account A holds. B's account holds nothing at all. */
  messageId: string;
  subject: string;
}

/**
 * TWO ACCOUNTS BEHIND ONE HOST, and every answer follows the CREDENTIAL rather than a global.
 *
 * This is the fixture detail that decides whether the test means anything. A fake that served one
 * feed to every bearer would refill a freshly discarded mirror with the very rows the discard
 * removed — and the assertion "B's window shows none of A's mail" would then be unprovable, because
 * a leaked row and a legitimately re-pulled one are the same bytes. So: A's bearer gets A's mailbox
 * and A's one message, B's bearer gets B's own empty mailbox, and `GET /auth/session` reads the
 * bearer exactly as the real route reads the session row behind it. Any A-shaped row visible to B
 * is therefore a leak by construction.
 *
 * `identity.address` chooses only who the next LOGIN mints a pair for — the person at the keyboard
 * typing somebody's credentials — and never what a held pair can see.
 */
function hostedService(): Hosted {
  const messageId = randomUUID();
  const threadId = randomUUID();
  const subject = "A's private mail";
  const identity = { address: A };
  const identityDown = { yes: false };
  const calls: string[] = [];
  let bodiesDrained = false;

  /** Whose bearer this is: the fake's whole notion of identity, read where the real one reads it. */
  const whose = (init?: RequestInit, input?: string | URL | Request): string | null => {
    const header = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).get("authorization");
    const token = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
    return token.startsWith("access-") ? token.slice("access-".length) : null;
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
    calls.push(url.pathname);
    if (url.pathname === "/auth/login") return json({ status: "twofa_required", loginToken: "lt" });
    if (url.pathname === "/auth/2fa/totp/verify") {
      return json({ status: "ok", tokens: { accessToken: `access-${identity.address}`, refreshToken: "r" } });
    }
    if (url.pathname === "/auth/desktop-claim") {
      return json({ tokens: { accessToken: `access-${identity.address}`, refreshToken: "r" } });
    }
    if (url.pathname === "/auth/session") {
      if (identityDown.yes) return new Response("gateway", { status: 502 });
      const holder = whose(init, input);
      if (!holder) return new Response("unauthorized", { status: 401 });
      return json({ user: { email: holder }, scope: "full" });
    }

    // ── EVERYTHING BELOW IS THE ACCOUNT'S OWN DATA, AND B'S ACCOUNT IS EMPTY ──────────────────
    const holder = whose(init, input);
    if (url.pathname === "/mailboxes") {
      return json(mailboxList([
        holder === A
          ? hostedMailbox(MAILBOX, A)
          : hostedMailbox("cccccccc-cccc-4ccc-8ccc-cccccccccccc", B),
      ]));
    }
    if (url.pathname === "/sync") {
      const since = url.searchParams.get("since") ?? "0";
      if (holder === A && since === "0") {
        return json(syncPage([
          change("thread", threadId, 1, threadDTO(threadId, subject)),
          change("message", messageId, 2, messageDTO(messageId, threadId, subject)),
        ], Buffer.from("2", "utf8").toString("base64url")));
      }
      return json(syncPage([], since === "0" ? Buffer.from("0", "utf8").toString("base64url") : since));
    }
    if (url.pathname === "/messages/bodies") {
      if (holder !== A || bodiesDrained) return json({ items: [], nextCursor: null });
      bodiesDrained = true;
      return json({
        items: [{ messageId, text: "the first account's body", html: null, loadedRemoteContent: false }],
        nextCursor: null,
      } satisfies Page<MessageBodyBatchItem>);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, identity, identityDown, calls, messageId, subject };
}

const signIn = (sidecar: CloudSidecar, address: string, token: string): Promise<Response> =>
  sidecar.handle(new Request("http://sidecar/cloud/signin", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ email: address, password: "cloud-sign-in-password", totp: "123456" }),
  }));

/** Wait for the first pull to land the message, since the sign-in deliberately does not await it. */
async function waitForMirror(sidecar: CloudSidecar, messageId: string, token: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await sidecar.handle(
      new Request(`http://sidecar/messages/${messageId}`, { headers: { authorization: `Bearer ${token}` } }),
    );
    // Filled means the pull that wrote the row has ENDED: the page apply takes turns, so a row is
    // readable while its pull is still running, and a sign-out then cuts it before the cursor.
    if (res.status === 200 && !sidecar.mirrorDraining()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Sign in as A, fill the mirror with A's mail, sign out. The state every case below starts from. */
async function mirrorOfA(dataDir: string, hosted: Hosted): Promise<CloudSidecar> {
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: A,
    keks: aKek(),
    fetchImpl: hosted.fetchImpl,
    pollIntervalMs: 3_600_000,
  });
  sidecars.push(sidecar);
  const token = sidecar.sessionToken;
  expect((await signIn(sidecar, A, token)).status).toBe(200);
  expect(await waitForMirror(sidecar, hosted.messageId, token), "A's mirror never filled").toBe(true);
  await sidecar.handle(new Request("http://sidecar/cloud/session", {
    method: "DELETE", headers: { authorization: `Bearer ${token}` },
  }));
  expect(sidecar.signedIn()).toBe(false);
  return sidecar;
}

describe("a sign-in that lands a DIFFERENT account than the mirror was built for", () => {
  it("is REFUSED, and B's session reads none of A's mail", async () => {
    const hosted = hostedService();
    const dataDir = await freshDir();
    const sidecar = await mirrorOfA(dataDir, hosted);
    const token = sidecar.sessionToken;

    // A's mail is on this disk, frozen by the sign-out. That is the state that makes the next
    // request dangerous, so it is asserted rather than assumed.
    expect(bytesUnder(join(dataDir, "pgdata")), "A's mirror was not on disk to be leaked").toBeGreaterThan(0);

    // ── SOMEBODY ELSE SIGNS IN ────────────────────────────────────────────────────────────────
    hosted.identity.address = B;
    const res = await signIn(sidecar, B, token);

    expect(res.status, await res.clone().text()).toBe(409);
    expect((await res.json()).error.code).toBe("mirror_owner_mismatch");

    // NOT SIGNED IN — there is no window in which this session is live over A's database.
    expect(sidecar.signedIn()).toBe(false);

    // THE ASSERTION THIS FILE EXISTS FOR, and it is on reads. A's message, A's list, A's threads:
    // every one of them is refused, and none of them carries a row.
    for (const path of [
      `/messages/${hosted.messageId}`,
      "/messages?view=imbox",
      "/mailboxes",
      "/sync?since=0",
    ]) {
      const read = await sidecar.handle(
        new Request(`http://sidecar${path}`, { headers: { authorization: `Bearer ${token}` } }),
      );
      const text = await read.text();
      expect(read.status, path).toBe(409);
      expect(text, `${path} carried the previous account's mail`).not.toContain(hosted.subject);
      expect(text, `${path} carried the previous account's message id`).not.toContain(hosted.messageId);
    }

    // AND THE REFUSAL KEPT NOTHING. A foreign pair sealed into this directory would be a session
    // the NEXT launch would activate over A's mirror without asking anybody.
    expect(existsSync(join(dataDir, "cloud-tokens.seal")), "a foreign session was sealed").toBe(false);
  }, 40_000);

  it("is refused even when the sign-in body CLAIMS to be the mirror's own account", async () => {
    // The address in the body is an input. A guard that compared it against the marker would agree
    // with itself here and admit B's session — which is why the comparison is against the identity
    // the hosted service resolves from the pair.
    const hosted = hostedService();
    const dataDir = await freshDir();
    const sidecar = await mirrorOfA(dataDir, hosted);
    const token = sidecar.sessionToken;

    hosted.identity.address = B;
    const res = await signIn(sidecar, A, token);

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("mirror_owner_mismatch");
    expect(sidecar.signedIn()).toBe(false);
  }, 40_000);

  it("names NEITHER account in its refusal", async () => {
    // Somebody signing in with their own credentials must not be told whose mail is on the machine.
    const hosted = hostedService();
    const sidecar = await mirrorOfA(await freshDir(), hosted);
    hosted.identity.address = B;
    const res = await signIn(sidecar, B, sidecar.sessionToken);
    const text = await res.text();
    expect(text).not.toContain(A);
    expect(text).not.toContain(B);
  }, 40_000);

  it("RE-BOOTSTRAPS clean once the door is re-pointed, with zero rows of A's mail", async () => {
    // The remedy the refusal names: the shell re-points the door, which replaces the engine — and
    // that is the one code path allowed to throw a mirror away, because it runs before the database
    // is opened. This is that relaunch, on the same data directory.
    const hosted = hostedService();
    const dataDir = await freshDir();
    const first = await mirrorOfA(dataDir, hosted);
    hosted.identity.address = B;
    expect((await signIn(first, B, first.sessionToken)).status).toBe(409);
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);

    const second = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      address: B,
      keks: aKek(),
      fetchImpl: hosted.fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(second);
    const token = second.sessionToken;

    // A's mirror is gone before a single request is served — the marker named A, the door names B.
    // The record holds the ADDRESS and the SERVER (see `cloud-origin.ts`); both are checked, so a
    // launch that wrote only half of it is red rather than passing on the half this case reads.
    expect(readMirrorOwner(dataDir)).toBe(B);
    expect(readMirrorBase(dataDir)).toBe("https://cloud.test");

    const res = await signIn(second, B, token);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(second.signedIn()).toBe(true);

    // ZERO ROWS OF A'S MAIL, read out of a live session rather than inferred from a flag. B's
    // account is empty at the fake, so every row here would have to have come from A's discarded
    // database — which is the leak, stated as a count. The read is `GET /sync/snapshot` — the
    // cold-start read the desktop engine takes, served from the LOCAL mirror in both modes
    // (`client-route-coverage.test.ts` pins that). It replaced `GET /messages` here when the
    // reach-past slice moved that route onto the hosted door: a list ask now measures the fake
    // upstream, not the mirror this test is about.
    const list = await second.handle(
      new Request("http://sidecar/sync/snapshot", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(list.status).toBe(200);
    const snap = (await list.json()) as { changes: Array<{ type: string }> };
    expect(
      snap.changes.filter((c) => c.type === "message"),
      "B's session read rows out of A's mirror",
    ).toHaveLength(0);

    // And A's message is not merely absent from a list — it cannot be addressed directly either.
    const direct = await second.handle(
      new Request(`http://sidecar/messages/${hosted.messageId}`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(direct.status, "A's message id still resolved under B's session").toBe(404);
    expect(await direct.text()).not.toContain(hosted.subject);
  }, 40_000);
});

describe("a sign-in that lands the SAME account", () => {
  it("leaves the mirror exactly where it is — byte for byte", async () => {
    // The legitimate case, and the one a discard would ruin: signing out and back in on your own
    // machine must never cost a re-pull. A 21 GB body store is preserved by doing nothing at all.
    const hosted = hostedService();
    const dataDir = await freshDir();
    const sidecar = await mirrorOfA(dataDir, hosted);
    const token = sidecar.sessionToken;

    const pgdata = join(dataDir, "pgdata");
    const before = bytesUnder(pgdata);
    const cursorBefore = readFileSync(join(dataDir, "cloud-cursor.json"), "utf8");
    expect(before).toBeGreaterThan(0);

    const res = await signIn(sidecar, A, token);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(sidecar.signedIn()).toBe(true);

    // NOT DISCARDED. The database is the same one, down to its size, and the cursor still points
    // where A's last pull left it — a re-bootstrap would have reset it to the start of the feed.
    expect(bytesUnder(pgdata), "the mirror was rebuilt on a same-account sign-in").toBe(before);
    expect(readFileSync(join(dataDir, "cloud-cursor.json"), "utf8")).toBe(cursorBefore);

    // And A's mail is still there to read, immediately, with no pull in between.
    const read = await sidecar.handle(
      new Request(`http://sidecar/messages/${hosted.messageId}`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(read.status).toBe(200);
    expect(await read.text()).toContain(hosted.subject);
  }, 40_000);

  it("is not confused by case or padding in the address the account answers with", async () => {
    const hosted = hostedService();
    const sidecar = await mirrorOfA(await freshDir(), hosted);
    hosted.identity.address = `  ${A.toUpperCase()}  `;
    const res = await signIn(sidecar, A, sidecar.sessionToken);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(sidecar.signedIn()).toBe(true);
  }, 40_000);
});

describe("an identity that cannot be established", () => {
  it("FAILS CLOSED: the pair is discarded unsealed and nothing is activated", async () => {
    // The gate may not be opened by a network blip. An unconfirmed identity falling through as a
    // match is the leak arriving by another route.
    const hosted = hostedService();
    const dataDir = await freshDir();
    const sidecar = await mirrorOfA(dataDir, hosted);
    const token = sidecar.sessionToken;

    hosted.identityDown.yes = true;
    const res = await signIn(sidecar, A, token);

    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("identity_unconfirmed");
    expect(sidecar.signedIn()).toBe(false);
    expect(existsSync(join(dataDir, "cloud-tokens.seal")), "an unattributed session was sealed").toBe(false);

    // And it is not a one-way door: the same install signs in the moment the account answers again.
    hosted.identityDown.yes = false;
    expect((await signIn(sidecar, A, token)).status).toBe(200);
  }, 40_000);
});

describe("a launch after a refused sign-in", () => {
  it("converges: the marker still names A, and A's mirror is intact and signed out", async () => {
    // The crash case. A sign-in refused (or a process killed) mid-transition must leave the
    // directory in the state the constructor already knows how to handle — it wrote nothing.
    const hosted = hostedService();
    const dataDir = await freshDir();
    const first = await mirrorOfA(dataDir, hosted);
    hosted.identity.address = B;
    expect((await signIn(first, B, first.sessionToken)).status).toBe(409);
    const bytes = bytesUnder(join(dataDir, "pgdata"));
    const cursor = readFileSync(join(dataDir, "cloud-cursor.json"), "utf8");
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);

    // The refused sign-in wrote NOTHING: the marker still names the account whose mail is here,
    // and the server it was bootstrapped against.
    expect(readMirrorOwner(dataDir)).toBe(A);
    expect(readMirrorBase(dataDir)).toBe("https://cloud.test");

    const relaunched = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      address: A,
      keks: aKek(),
      fetchImpl: hosted.fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(relaunched);

    // NOT RE-BOOTSTRAPPED. An exact byte equality is the wrong assertion across a relaunch —
    // reopening PGlite writes a little on its own account (checked: it grows by ~150 KB) — so the
    // claim is the one that matters: the store did not shrink to a fresh bootstrap, and the cursor
    // still points where A's last pull left it rather than at the start of the feed.
    expect(bytesUnder(join(dataDir, "pgdata"))).toBeGreaterThanOrEqual(bytes);
    expect(readFileSync(join(dataDir, "cloud-cursor.json"), "utf8")).toBe(cursor);
    expect(relaunched.signedIn()).toBe(false);

    hosted.identity.address = A;
    expect((await signIn(relaunched, A, relaunched.sessionToken)).status).toBe(200);
    // Served out of the SURVIVING mirror, not out of a re-pull: the cursor above is past this
    // message, so A's feed answers the resumed `/sync` with nothing.
    const read = await relaunched.handle(new Request(`http://sidecar/messages/${hosted.messageId}`, {
      headers: { authorization: `Bearer ${relaunched.sessionToken}` },
    }));
    expect(read.status).toBe(200);
    expect(await read.text()).toContain(hosted.subject);
  }, 40_000);
});
