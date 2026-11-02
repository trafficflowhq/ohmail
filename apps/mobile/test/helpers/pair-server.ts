/**
 * A loopback server speaking the connection contract — `/hello`, the pair redeem, the
 * refresh rotation with STRICT REUSE (the native branch: presenting a consumed refresh token
 * revokes the family), both sign-out doors, and the /sync surface behind a real bearer check. Every request is
 * recorded whole (`seen`), which is what lets the suites assert the token DISCIPLINE — the
 * pairing token appearing in exactly one place, the redeem body — rather than trusting it.
 *
 * Plain `http://127.0.0.1` on purpose: the LAN desktop-host door is plain http, and the whole
 * point of the native client (ruling §1b) is that no secure-context gate stops it.
 *
 * The sqlite half (`sqlWorld`) mirrors the engine-boot helper: `node:sqlite` behind the same
 * `SqlExecutor` seam expo-sqlite implements.
 */
import {
  pairWithServer,
  probePairing,
  type PairOutcome,
  type PairingEnv,
} from "../../src/net/pairing";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
  decodeSeqCursor,
  encodeSeqCursor,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
  type SyncChange,
} from "@ohmail/client-engine";

/* ── node:sqlite behind the statement-runner seam (shared for this app's tests) ─────────────── */

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export function sqlWorld() {
  const dbs = new Map<string, DatabaseSync>();
  return {
    open: (name: string): SqlExecutor => {
      let db = dbs.get(name);
      if (!db) {
        db = new sqlite.DatabaseSync(":memory:");
        dbs.set(name, db);
      }
      return nodeSqlExecutor(db);
    },
    names: (): string[] => [...dbs.keys()],
    /**
     * DELETE the named database, the way a device does: the handle is closed and the file is
     * gone, so the next `open` of that name yields a NEW, EMPTY database. That last property is
     * what makes an absence assertion mean something — a double that merely emptied the tables
     * would let a forget "pass" while the physical database still existed under the same name.
     */
    drop: async (name: string): Promise<void> => {
      const db = dbs.get(name);
      dbs.delete(name);
      try {
        db?.close();
      } catch {
        /* already closed — the delete is what matters */
      }
    },
    /** The raw handle — the isolation suite opens one database under a FOREIGN owner. */
    raw: (name: string): DatabaseSync | undefined => dbs.get(name),
  };
}

/* ── the wire fixtures ───────────────────────────────────────────────────────────────────────── */

export function messageDto(id: string, seq: number, subject: string, accountId: string) {
  return {
    id,
    accountId,
    mailboxId: "mb-1",
    threadId: null,
    messageIdHeader: `<${id}@fake>`,
    subject,
    from: { name: "Test Sender", address: "sender@fake.test" },
    to: [],
    cc: [],
    date: "2026-08-19T08:00:00Z",
    folder: "INBOX",
    snippet: subject,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-19T08:00:00Z",
    seqHint: seq,
  };
}

/* ── the server ──────────────────────────────────────────────────────────────────────────────── */

export interface SeenRequest {
  method: string;
  /** Path + query, exactly as it arrived — where a leaked token would show up. */
  url: string;
  auth: string | undefined;
  body: string;
}

export interface PairServerOptions {
  accountId?: string;
  flavor?: string;
  /** `features.pairing` in /hello AND whether the redeem is mounted — one truth, both edges. */
  pairing?: boolean;
  /** The standalone server mounts `/auth/session`; the desktop-host door does not. */
  sessionRoute?: boolean;
  /**
   * The redeem's `kind` whitelist, mirroring the real servers' three generations: absent = the
   * CURRENT vocabulary (the mobile kinds admissible); an explicit narrow list (e.g.
   * `["web", "macos"]`) = the older server whose whitelist predates them — it refuses a present
   * out-of-set kind `validation_failed` BEFORE the burn, exactly as every real version that
   * validates the field has; `null` = the oldest wire, which never read the field at all.
   */
  kindWhitelist?: readonly string[] | null;
}

/** The current server's closed set — `PAIRED_DEVICE_KINDS` on the service side. */
const CURRENT_KINDS = [
  "web", "macos", "desktop-linux", "desktop-macos", "desktop-windows",
  "mobile-android", "mobile-ios",
] as const;

export function pairServer(opts: PairServerOptions = {}) {
  const account = opts.accountId ?? "acct-1";
  const flavor = opts.flavor ?? "desktop-host";
  const pairing = opts.pairing !== false;
  const sessionRoute = opts.sessionRoute === true;

  const log: SyncChange[] = [];
  let seq = 0;
  const mintable = new Set<string>();
  /** The family's one live refresh token — rotation moves it; reuse of an old one revokes. */
  let refreshHead: string | null = null;
  let revoked = false;
  /** Every refresh token minted, and the redeem's family it belongs to: the refresh door's reach. */
  const familyOf = new Map<string, number>();
  let family = 0;
  const liveAccess = new Set<string>();
  let mintCounter = 0;
  const seen: SeenRequest[] = [];
  let refreshPresentations = 0;
  /** The hosted account was erased: a declared ask hears `410 account_erased`, an undeclared one 401. */
  let erased = false;

  const addMessage = (id: string, subject: string) => {
    seq += 1;
    log.push({
      type: "message",
      op: "create",
      id,
      seq,
      updatedAt: "2026-08-19T08:00:00Z",
      entity: messageDto(id, seq, subject, account),
    });
  };

  const mintPair = () => {
    mintCounter += 1;
    const tokens = { accessToken: `acc-${mintCounter}`, refreshToken: `ref-${mintCounter}` };
    refreshHead = tokens.refreshToken;
    familyOf.set(tokens.refreshToken, family);
    liveAccess.add(tokens.accessToken);
    return tokens;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "GET", url: req.url ?? "/", auth: req.headers.authorization, body });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const authed = (): boolean => {
        const auth = req.headers.authorization ?? "";
        return auth.startsWith("Bearer ") && liveAccess.has(auth.slice("Bearer ".length));
      };
      const unauthorized = () => json(401, { error: { code: "unauthorized", message: "no live session" } });

      if (url.pathname === "/hello") {
        json(200, {
          product: "ohmail",
          flavor,
          apiVersion: "1",
          needsSetup: false,
          auth: { password: false, totp: false, webauthn: false, publicSignup: false },
          features: { sse: false, staging: false, ai: false, pairing },
        });
        return;
      }
      if (url.pathname === "/pair/redeem" && req.method === "POST") {
        if (!pairing) {
          json(404, { error: { code: "not_found", message: "no such route" } });
          return;
        }
        let parsed: { grant?: unknown; token?: unknown; kind?: unknown } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          /* falls through to the refusal */
        }
        // The whitelist gate, BEFORE the token lookup and the burn — the real ordering in every
        // server version that reads the field (`redeemDevicePair` refuses ahead of the consume).
        const whitelist = opts.kindWhitelist === undefined ? CURRENT_KINDS : opts.kindWhitelist;
        if (whitelist !== null && parsed.kind !== undefined &&
            (typeof parsed.kind !== "string" || !whitelist.includes(parsed.kind))) {
          json(400, {
            error: {
              code: "validation_failed",
              message: `device kind must be one of ${whitelist.map((k) => `"${k}"`).join(", ")}`,
            },
          });
          return;
        }
        if (parsed.grant !== "device-pair" || typeof parsed.token !== "string" || !mintable.has(parsed.token)) {
          json(404, { error: { code: "pairing_invalid", message: "no live pairing token matches" } });
          return;
        }
        mintable.delete(parsed.token); // single-use: the burn
        revoked = false;
        family += 1;
        json(200, { grant: "device-pair", tokens: mintPair() });
        return;
      }
      if (erased) {
        // The hosted API's answer to an erased account's token (`packages/api/src/middleware.ts`),
        // naming the account, and only for a request that declared it understands it. The kept
        // access hash lapses with the token: past it a read is a plain 401 and the refresh tells.
        if (url.pathname === "/auth/refresh") refreshPresentations += 1;
        const told = url.pathname === "/auth/refresh" || authed();
        if (told && req.headers["x-ohmail-accepts"] === "account_erased") {
          res.writeHead(410, { "content-type": "application/json", "x-ohmail-account": account });
          res.end(JSON.stringify({ error: { code: "account_erased", message: "this account has been deleted" } }));
        } else {
          unauthorized();
        }
        return;
      }
      if (url.pathname === "/auth/refresh" && req.method === "POST") {
        refreshPresentations += 1;
        let parsed: { refreshToken?: unknown } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          /* refusal below */
        }
        if (revoked || typeof parsed.refreshToken !== "string" || parsed.refreshToken !== refreshHead) {
          // STRICT REUSE: an old head presented again is the theft signal — the family dies.
          revoked = true;
          liveAccess.clear();
          json(401, { error: { code: "unauthorized", message: "this session cannot be resumed" } });
          return;
        }
        json(200, { tokens: mintPair() });
        return;
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        // An authenticated route, like the real table's: no bearer ⇒ 401 (which is what lets
        // the revoke path's manager buy an access token through its one recovery). With one,
        // logout ends the family: the next refresh presentation answers 401.
        if (!authed()) {
          unauthorized();
          return;
        }
        revoked = true;
        liveAccess.clear();
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/auth/refresh/logout" && req.method === "POST") {
        // The real door: a token this server minted ends its family in any state, a spent one too;
        // one it never minted is the door's own 401. No bearer is read.
        let parsed: { refreshToken?: unknown } = {};
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          /* refusal below */
        }
        const named = typeof parsed.refreshToken === "string" ? familyOf.get(parsed.refreshToken) : undefined;
        if (named === undefined) {
          json(401, { error: { code: "unauthorized", message: "nothing to sign out" } });
          return;
        }
        if (named === family) {
          revoked = true;
          liveAccess.clear();
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/auth/session") {
        if (!sessionRoute) {
          json(404, { error: { code: "not_found", message: "no such route" } });
          return;
        }
        if (!authed()) {
          unauthorized();
          return;
        }
        json(200, { user: { accountId: account }, scope: "full" });
        return;
      }
      if (url.pathname === "/sync/snapshot") {
        if (!authed()) {
          unauthorized();
          return;
        }
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : undefined;
        const all = log.map((ch) => ({ ...ch, seq }));
        json(200, {
          asOfSeq: seq,
          changes: limit !== undefined ? all.slice(0, limit) : all,
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
        return;
      }
      if (url.pathname === "/sync") {
        if (!authed()) {
          unauthorized();
          return;
        }
        const since = url.searchParams.get("since") ?? "0";
        const from = since === "0" ? 0 : decodeSeqCursor(since);
        if (from === null) {
          json(410, { error: { code: "cursor_expired", message: "cursor expired" } });
          return;
        }
        const changes = log.filter((ch) => ch.seq > from);
        json(200, {
          changes: { creates: changes, updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(Math.max(from, ...changes.map((c) => c.seq), 0)),
          hasMore: false,
          serverTime: new Date().toISOString(),
        });
        return;
      }
      json(404, { error: { code: "not_found", message: "no such route" } });
    });
  });

  return {
    server,
    addMessage,
    /** Put a single-use pairing token on the table — what the desktop's Devices pane mints. */
    mintPairToken: (token: string) => mintable.add(token),
    /** The desktop Devices revoke: every access token dies NOW, the refresh answers 401. */
    revoke: () => {
      revoked = true;
      liveAccess.clear();
    },
    /** The account is erased: every session and refresh token of it now names an erased account. */
    erase: () => {
      erased = true;
    },
    /** Access tokens age out; the refresh family stays whole — forces one clean rotation. */
    expireAccess: () => liveAccess.clear(),
    /**
     * The lost-response residual: the SERVER committed a rotation the client never learned
     * about (mid-rotation kill). The client's stored refresh is now the reuse signal.
     */
    rotateServerSide: () => {
      if (refreshHead !== null) mintPair();
      liveAccess.clear();
    },
    seen,
    refreshPresentations: () => refreshPresentations,
    currentSeq: () => seq,
  };
}

/** Listen on an ephemeral loopback port; answer the PLAIN-HTTP origin. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

/**
 * THE WHOLE CEREMONY AS A SCREEN DRIVES IT — probe, then redeem.
 *
 * `pairWithServer` stopped taking an origin when the pairing grew a confirmation: it takes the
 * {@link PairAdmission} a credential-free probe produced, so there is no way to reach a redeem
 * from a scanned string and skip the person (`src/net/pairing.ts`). Thirty-one call sites in this
 * suite were driving the old one-shot function; they drive both halves through this, which is the
 * sequence `app/scan.tsx` and `app/connect.tsx` actually perform.
 *
 * IT LIVES IN `test/helpers` ON PURPOSE and must stay there. A helper like this inside `src`
 * would be exactly the bypass the type exists to remove — `doors.test.ts` holds the source census
 * that names the two screens allowed to redeem, so a product file growing one of these is red.
 */
export async function pairThroughConfirm(
  env: PairingEnv,
  input: { origin: string; token: string; pin?: string | null },
): Promise<PairOutcome> {
  const probed = await probePairing(env, { origin: input.origin, pin: input.pin ?? null });
  if (probed.kind === "refused") return { kind: "refused", reason: probed.reason };
  return await pairWithServer(env, { admission: probed.admission, token: input.token });
}
