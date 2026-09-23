import { randomUUID } from "node:crypto";
import { hashToken } from "@trafficflow/services/mail";
import type { MailboxDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";

/**
 * A FAKE OHMAIL CLOUD THAT ANSWERS THE FIVE APPROVAL ROUTES the way `auth-service.ts` does — request,
 * read, confirm, deny, claim — plus the code fallback's two (mint, claim), the session read the
 * engine takes the account from and just enough mail for a first drain. The browser's half (read,
 * confirm, deny, mint) is driven by the test through the routes the pages call, bound to whichever
 * account `browser` names. Fixture accounts only; nothing here dials anywhere. Shared by the
 * window's walk and the engine's own adoption walk in the sidecar's slow tests.
 */

export const FIXTURE_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FIXTURE_MESSAGE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type RequestState = "pending" | "approved" | "denied" | "used";
interface ApprovalRow {
  id: string;
  challenge: string;
  label: string;
  state: RequestState;
  account: string | null;
  expiresAt: number;
  requestedAt: string;
}

/** One hosted mailbox as `GET /mailboxes` answers it: organized there, consented to nothing. */
function hostedMailbox(id: string, address: string): MailboxDTO {
  const at = "2026-01-01T00:11:00.000Z";
  return {
    id, provider: "imap", address, displayName: null, status: "connected", authKind: "password",
    lastSyncAt: at, errorCode: null, errorDetail: null, failedAt: null, retryCount: 0,
    syncBlockedReason: null, syncBlockedSince: null, disabledReason: null, initialImportCompletedAt: at,
    pendingMoves: 0,
    filing: { due: 0, deferred: 0, oldestPendingAt: null, nextAttemptAt: null, attempts: 0, lastRefusalClass: null, asOf: at, lastCycleAt: null },
    organizerRole: "organizer", organizedBy: null, organizerState: null, organizedByThisInstall: true,
    organizeConsentedAt: null, organizerEventAt: null, organizerEventSeenAt: null, organizerAcceptsRequests: false,
    organizerReleasedAt: null, releaseRequestedAt: null, releaseRefusal: null, takeoverAuthorizedAt: null,
    inboundQuietSince: null, inboundQuietDismissedAt: null, smtpMaxSizeBytes: null, folders: [],
    createdAt: "2026-01-01T00:04:00.000Z",
  };
}

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const refused = (code: string, status: number): Response => json({ error: { code, message: code } }, status);

function messagePage(owner: string): SyncResponse {
  const at = new Date().toISOString();
  return {
    changes: {
      creates: [{
        type: "message", op: "create", id: FIXTURE_MESSAGE, seq: 1, updatedAt: at,
        entity: {
          id: FIXTURE_MESSAGE, accountId: "acct", mailboxId: FIXTURE_MAILBOX, threadId: null, messageIdHeader: null,
          subject: `welcome, ${owner.split("@")[0]}`, from: { name: null, address: "hello@elsewhere.test" }, to: [],
          cc: [], date: at, folder: "INBOX", snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
          sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
          triage: null, labels: [], remoteContent: "none", updatedAt: at,
        },
      }] as unknown as SyncChange[],
      updates: [], moves: [], deletes: [],
    },
    cursor: "c1", hasMore: false, serverTime: at,
  };
}

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "c1", hasMore: false, serverTime: new Date().toISOString(),
});

export interface ApprovalServer {
  fetchImpl: typeof fetch;
  /** The account the browser is signed in to — the one a confirm binds. */
  browser: string;
  /** Every path the engine dialled, in order. */
  dialled: string[];
  /** The browser's three routes, through the fake's own fetch. */
  read(id: string): Promise<Response>;
  confirm(id: string): Promise<Response>;
  deny(id: string): Promise<Response>;
  /** The request's clock runs out. */
  expire(id: string): void;
  /** The code fallback's page: a code bound to the window's challenge, for the browser's account. */
  mintCode(challenge: string): Promise<string>;
  lastRequest(): ApprovalRow | undefined;
}

export function approvalServer(base: string, browser = "mila@ohmail.test"): ApprovalServer {
  const rows = new Map<string, ApprovalRow>();
  const codes = new Map<string, { challenge: string; account: string; used: boolean }>();
  const owners = new Map<string, string>();
  let minted = 0;
  const served = new Set<string>();
  const server: ApprovalServer = {
    browser,
    dialled: [],
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const path = url.pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      server.dialled.push(`${method} ${path}`);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

      if (method === "POST" && path === "/auth/desktop-approval") {
        const id = randomUUID();
        rows.set(id, {
          id, challenge: String(body.challenge ?? ""), label: String(body.label ?? ""), state: "pending",
          account: null, expiresAt: Date.now() + 300_000, requestedAt: new Date().toISOString(),
        });
        return json({ approvalId: id, expiresIn: 300 });
      }
      if (method === "POST" && path === "/auth/desktop-approval/claim") {
        const row = rows.get(String(body.approvalId ?? ""));
        if (!row || hashToken(String(body.verifier ?? "")) !== row.challenge) return refused("invalid_approval", 410);
        if (row.state === "used") return refused("approval_used", 410);
        if (row.state === "denied") return refused("approval_denied", 410);
        if (Date.now() >= row.expiresAt) return refused("approval_expired", 410);
        if (row.state === "pending") return json({ status: "pending", retryAfterMs: 2_000 }, 202);
        row.state = "used";
        minted += 1;
        const access = `fixture-access-${minted}`;
        owners.set(access, row.account!);
        return json({ tokens: { accessToken: access, refreshToken: `fixture-refresh-${minted}` } });
      }
      /* The code fallback: the page mints a code for the challenge, the engine claims it once. */
      if (method === "POST" && path === "/auth/desktop-link") {
        const code = `FX${String(codes.size + 1).padStart(6, "0")}`;
        codes.set(code, { challenge: String(body.challenge ?? ""), account: server.browser, used: false });
        return json({ code, expiresIn: 120 });
      }
      if (method === "POST" && path === "/auth/desktop-claim") {
        const held = codes.get(String(body.code ?? ""));
        if (!held || held.used || hashToken(String(body.verifier ?? "")) !== held.challenge) return refused("invalid_code", 401);
        held.used = true;
        minted += 1;
        const access = `fixture-access-${minted}`;
        owners.set(access, held.account);
        return json({ tokens: { accessToken: access, refreshToken: `fixture-refresh-${minted}` } });
      }
      const one = /^\/auth\/desktop-approval\/([^/]+)(\/confirm|\/deny)?$/.exec(path);
      if (one) {
        const row = rows.get(one[1]!);
        if (!row) return refused("not_found", 404);
        if (Date.now() >= row.expiresAt) return refused("approval_expired", 410);
        if (!one[2] && method === "GET") {
          return json({
            label: row.label, platform: null, ipClass: null, requestedAt: row.requestedAt,
            expiresIn: Math.ceil((row.expiresAt - Date.now()) / 1000), approved: row.state === "approved",
          });
        }
        if (one[2] === "/confirm") { row.state = "approved"; row.account = server.browser; return json({ approved: true }); }
        if (one[2] === "/deny") { row.state = "denied"; return json({ denied: true }); }
      }
      if (path === "/auth/session") {
        const owner = owners.get(bearer);
        return owner ? json({ user: { email: owner }, scope: "full" }) : refused("unauthorized", 401);
      }
      const owner = owners.get(bearer);
      if (!owner) return refused("unauthorized", 401);
      if (path.startsWith("/mailboxes")) return json({ items: [hostedMailbox(FIXTURE_MAILBOX, owner)] });
      if (path.startsWith("/sync/snapshot")) {
        return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
      }
      if (path.startsWith("/sync") && url.searchParams.get("types") === "rule") return json(emptyPage());
      if (path.startsWith("/sync")) {
        if (served.has(owner)) return json(emptyPage());
        served.add(owner);
        return json(messagePage(owner));
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch,
    read: (id) => server.fetchImpl(`${base}/auth/desktop-approval/${id}`),
    confirm: (id) => server.fetchImpl(`${base}/auth/desktop-approval/${id}/confirm`, { method: "POST", body: "{}" }),
    deny: (id) => server.fetchImpl(`${base}/auth/desktop-approval/${id}/deny`, { method: "POST", body: "{}" }),
    expire: (id) => { const row = rows.get(id); if (row) row.expiresAt = 0; },
    mintCode: async (challenge) => {
      const res = await server.fetchImpl(`${base}/auth/desktop-link`, { method: "POST", body: JSON.stringify({ challenge }) });
      return ((await res.json()) as { code: string }).code;
    },
    lastRequest: () => [...rows.values()].at(-1),
  };
  return server;
}
