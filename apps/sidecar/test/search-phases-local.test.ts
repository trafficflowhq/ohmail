import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator, OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { WINDOW_SEARCH_PHASES_ROUTE } from "../src/window-report.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE STANDALONE DESKTOP'S ENGINE TAKES THE SAME SEARCH TIMINGS. The window's record reaches this
 * door on the local engine too, so a standalone Search is timed in the same log with the same
 * line; the Cloud door's arms are in `search-phases.test.ts`. The mailbox is a quiet fake that
 * is never dialled.
 */

class MemoryMetaFolder implements LeaseIo {
  private claims: RawClaimMessage[] = [];
  private nextUid = 1;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    this.claims = this.claims.filter((c) => !gone.has(c.ref));
  }
  uidValidity(): number | bigint | null { return 4_100; }
}

const EMPTY_BATCH: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
const ADDRESS = "owner@trafficflow.test";

function quietMailbox(): (cfg: ImapConfig) => MailboxAdapter & { leaseIo(): LeaseIo } {
  const meta = new MemoryMetaFolder();
  return () => ({
    leaseIo: () => meta,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  });
}

const lines: Array<Record<string, unknown>> = [];
let sidecar: Sidecar;
let dir: string;
beforeAll(async () => {
  dir = await freshDataDir("ohmail-search-phases-local-");
  const logger = createSidecarLogger({ sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); } });
  sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "mailbox-unreached-password" } },
    address: ADDRESS, machineName: "search phases host",
    pollIntervalMs: 60 * 60 * 1000, vitalsIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
    adapterFactory: quietMailbox(), log: diagnosticFor(logger), logger,
  });
});
afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const REPORT = {
  verdict: "nothing", debounceMs: 250, sendMs: 0, roundTripMs: 15, paintMs: 1, totalMs: 266, serverMs: 11,
  sentAtMs: 1_790_000_000_000, answeredAtMs: 1_790_000_000_015,
};
const post = (headers: Record<string, string>): Promise<Response> =>
  sidecar.handle(new Request(`http://local${WINDOW_SEARCH_PHASES_ROUTE}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(REPORT),
  }));

describe("the local engine's search-phases door", () => {
  it("with the launch bearer: 204 and one window_search_phases line, every field kept", async () => {
    lines.length = 0;
    const res = await post({ authorization: `Bearer ${sidecar.sessionToken}` });
    expect(res.status).toBe(204);
    const got = lines.filter((l) => l.event === "window_search_phases");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject(REPORT);
    expect(got[0]!.droppedFields).toBeUndefined();
  });

  it("CONTROL: without it, 401 and no line", async () => {
    lines.length = 0;
    const res = await post({});
    expect(res.status).toBe(401);
    expect(lines.filter((l) => l.event === "window_search_phases")).toHaveLength(0);
  });
});
