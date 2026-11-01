import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImapAdapter,
  type ChangeBatch, type FetchedPart, type ImapCapabilities, type ImapConfig, type MailboxAdapter,
  type OutboundMessage, type SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, makeProfileDoc, profileFingerprint,
  type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { PROFILE_FOUND_AUDIT_ACTION, auditLog } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from "../src/frame.js";
import { serveOverStdio } from "../src/host.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE CARD'S QUESTION ON THE DESKTOP DOOR, through the stdio host the window talks to. The
 * organizer's drain reads `ohmail/_meta` and records the document it holds; the card's GET is
 * answered from that record and never dials (the API door's own `ImapAdapter` is spied and
 * refuses). A mailbox removed from this install has no check: the same GET answers `none`, and
 * the host writes no `request_refused` for it (VTF2-02, 117 refused checks in one day).
 */

const DOC = makeProfileDoc({
  screener: [{ address: "friend@elsewhere.example" }],
  rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null,
}, { updatedAt: new Date("2026-09-20T08:00:00Z"), producer: { kind: "local", version: "0.25.1" } });
const FP = profileFingerprint(DOC);
const GENERATION = 4_100;

/** An in-memory `ohmail/_meta` carrying the lease's claims and the settings documents. */
class MemoryMeta implements LeaseIo, ProfileIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  private readonly profiles: Array<{ ref: number; raw: string }> = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> { drop(this.claims, refs); }
  uidValidity(): number { return GENERATION; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[]> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: GENERATION })).reverse();
  }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> { drop(this.profiles, refs); }
}

function drop<T extends { ref: unknown }>(list: T[], refs: readonly unknown[]): void {
  const gone = new Set(refs);
  for (let i = list.length - 1; i >= 0; i--) if (gone.has(list[i]!.ref)) list.splice(i, 1);
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** The engine's mailbox: every dial is one adapter, counted, all over the same folder. */
function mailbox(meta: MemoryMeta) {
  const state = { dials: 0 };
  const factory = (_cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo } => {
    state.dials += 1;
    return {
      leaseIo: () => meta,
      leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
      profileIo: () => meta,
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> { return EMPTY; },
      async move(): Promise<never> { throw new Error("nothing is filed in this case"); },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
    } as MailboxAdapter & { leaseIo(): LeaseIo };
  };
  return { factory, dials: () => state.dials };
}

/** The window's door: one request frame in, one response frame out, every host line kept. */
function stdioDoor(sidecar: Sidecar) {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new FrameDecoder({});
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const answers = new Map<number, { status: number; body: Buffer }>();
  output.on("data", (chunk: Buffer) => {
    for (const f of decoder.push(chunk)) {
      const h = f.header as { t?: string; id?: number; status?: number };
      if (h.t === "res" && typeof h.id === "number" && typeof h.status === "number") answers.set(h.id, { status: h.status, body: f.body });
    }
  });
  const host = serveOverStdio({
    handle: (req) => sidecar.handle(req), input, output,
    log: (event: string, fields?: Record<string, unknown>) => { lines.push({ event, fields: fields ?? {} }); },
  });
  let next = 1;
  return {
    async ask(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const id = next++;
      input.write(encodeFrame({
        v: PROTOCOL_VERSION, t: "req", id, method, url: `http://sidecar${path}`,
        h: [["authorization", `Bearer ${sidecar.sessionToken}`], ...(body === undefined ? [] : [["content-type", "application/json"]])],
      }, body === undefined ? undefined : Buffer.from(JSON.stringify(body))));
      for (let i = 0; i < 2_000 && !answers.has(id); i++) await new Promise((r) => setTimeout(r, 5));
      const a = answers.get(id);
      if (!a) throw new Error(`no answer to ${method} ${path}`);
      const text = a.body.toString("utf8");
      return { status: a.status, json: text ? JSON.parse(text) : null };
    },
    refused: (route: string): number => lines.filter((l) => l.event === "request_refused" && String(l.fields.route).includes(route)).length,
    stop: () => host.stop(),
  };
}

describe("the settings card asks without the door's clock", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function organizerWithADocument(doc = DOC): Promise<{ sidecar: Sidecar; meta: MemoryMeta }> {
    const meta = new MemoryMeta();
    await meta.appendProfile(formatProfileMessage(doc, { installId: "the-previous-mac" }));
    const box = mailbox(meta);
    const dataDir = await freshDataDir("ohmail-card-clock-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "this computer",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      adapterFactory: box.factory,
      // A key ring, so the boot seals the password into the store as the shipped desktop does.
      keks: { 1: randomBytes(32) },
    });
    cleanups.push(async () => {
      await sidecar.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    await sidecar.syncUntilQuiet();
    return { sidecar, meta };
  }

  it("the organizer's record answers the card with no dial; a removed mailbox answers `none` and is never refused", async () => {
    const { sidecar } = await organizerWithADocument();
    const mailboxId = sidecar.world.mailboxId;
    // The record is the organizer's, written at its drain's read — not seeded by this test.
    const markers = await sidecar.db.select({ payload: auditLog.payload }).from(auditLog)
      .where(and(eq(auditLog.accountId, sidecar.world.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
    expect(markers.map((m) => m.payload)).toContainEqual(expect.objectContaining({ fingerprint: FP, heldForImport: true }));

    const connect = vi.spyOn(ImapAdapter.prototype, "connect")
      .mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const door = stdioDoor(sidecar);
    cleanups.push(() => door.stop());
    const route = `/mailboxes/${mailboxId}/profile-import`;

    const asked = await door.ask("GET", route);
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json).toMatchObject({
      state: "found", fingerprint: FP,
      counts: { screener: 1, rules: 0, notifyRules: 0, tags: 1, awayResponder: false, signature: false },
    });
    expect(connect, "the card's question dialled the mailbox").toHaveBeenCalledTimes(0);

    expect((await door.ask("DELETE", `/local/mailboxes/${mailboxId}`)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const again = await door.ask("GET", route);
      expect(again.status, JSON.stringify(again.json)).toBe(200);
      expect(again.json).toEqual({ state: "none" });
    }
    expect(door.refused("/profile-import"), "a check on a removed mailbox was refused").toBe(0);
    expect(connect).toHaveBeenCalledTimes(0);
  });

  it("Import brings the copy's signature back: the card names it, /consent serves it, the window's stamp moves", async () => {
    const SIG = "-- \nthe old sign-off";
    const doc = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: SIG,
    }, { updatedAt: new Date("2026-09-20T08:00:00Z"), producer: { kind: "local", version: "0.30.20" } });
    const { sidecar } = await organizerWithADocument(doc);
    const mailboxId = sidecar.world.mailboxId;
    const door = stdioDoor(sidecar);
    cleanups.push(() => door.stop());
    const route = `/mailboxes/${mailboxId}/profile-import`;
    const asked = await door.ask("GET", route);
    expect(asked.json).toMatchObject({ state: "found", counts: { signature: true } });

    const stampOf = (page: any): string | null => {
      const all = [...page.changes.creates, ...page.changes.updates].filter((c: any) => c.type === "settings");
      return all.length === 0 ? null : all[all.length - 1].entity.updatedAt;
    };
    const before = (await door.ask("GET", "/sync?since=0")).json;
    const pressed = await door.ask("POST", route, { fingerprint: profileFingerprint(doc) });
    expect([200, 202], JSON.stringify(pressed.json)).toContain(pressed.status);
    for (let i = 0; i < 20 && pressed.status === 202; i++) {
      await sidecar.syncUntilQuiet();
      if ((await door.ask("GET", `${route}/status?fingerprint=${profileFingerprint(doc)}`)).json.state !== "importing") break;
    }
    expect((await door.ask("GET", "/consent")).json.signatures[mailboxId]).toBe(SIG);
    const after = (await door.ask("GET", `/sync?since=${before.cursor}`)).json;
    const moved = stampOf(after);
    expect(moved, "no settings change reached the window after Import").not.toBeNull();
    expect(stampOf(before) === null || moved! > stampOf(before)!,
      `the settings stamp did not move (${stampOf(before)} → ${moved}): the window keeps "No signature"`).toBe(true);
  });
});
