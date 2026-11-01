import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/log.js";
import {
  LeaseUnavailableError, formatClaim, runLeaseGate,
  type LeaseIo, type LeaseSelf, type RawClaimMessage,
} from "../../src/adapters/organizer-lease.js";
import {
  formatProfileMessage, makeProfileDoc, tidyOrganizerProfile, writeOrganizerProfile,
  type OrganizerProfilePayload, type ProfileIo, type RawProfileMessage,
} from "../../src/adapters/organizer-profile.js";

/**
 * NO LEASE OR PROFILE FAILURE LINE NAMES THE MAIL SERVER. A failed release or cleanup used to log
 * `err.message`, which the logger writes out as `errorText`, so a host inside an IMAP error's text
 * reached the drain. The real logger sits behind the worker's own forwarder shape here, and each
 * case drives one of the ten call sites with a synthetic host in the error. The line must still be
 * written, carrying the error's class and code.
 */

const HOST = `imap-${randomUUID().slice(0, 8)}.mail.example`;
const NOW = new Date("2026-08-01T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const boom = (): Error => Object.assign(new Error(`EXPUNGE failed: connection to ${HOST}:993 reset`), { code: "ECONNRESET" });

type Line = { event: string; op?: string; errorClass?: string; errorCode?: string; errorText?: string };

/** The real logger behind the worker's forwarder: `detail` spread into the fields, `err` and all. */
function drain(): { log: (event: string, detail: Record<string, unknown>) => void; raw: string[]; lines: () => Line[] } {
  const raw: string[] = [];
  const logger = createLogger({ service: "worker", level: "debug", sink: (l) => { raw.push(l); } });
  return {
    raw,
    log: (event, detail) => { logger.info(event, { ...detail, mailboxId: "22222222-2222-4222-8222-222222222222" }); },
    lines: () => raw.map((l) => JSON.parse(l) as Line),
  };
}

/** Every case's verdict: the line was written, names the error by class and code, and not the host. */
function judge(d: ReturnType<typeof drain>, event: string, op: string): void {
  const hits = d.lines().filter((l) => l.event === event && l.op === op);
  expect(hits.length, `no ${event} (${op}) line was written, so this case reached no call site`).toBeGreaterThan(0);
  for (const l of hits) expect.soft([l.errorClass, l.errorCode], "the line lost the error's class and code").toEqual(["Error", "ECONNRESET"]);
  expect.soft(d.raw.filter((l) => l.includes(HOST)).map((l) => (JSON.parse(l) as Line).event),
    "these lines carry the mail server's name").toEqual([]);
}

class Folder implements LeaseIo {
  messages: RawClaimMessage[] = [];
  removals = 0;
  private nextRef = 1;
  onAppend: ((raw: string) => void) | null = null;
  onRemove: (refs: readonly unknown[], call: number) => Promise<void> = async () => { throw boom(); };
  uidValidity(): number { return 1_000; }
  async ensureMetaFolder(): Promise<void> { /* exists */ }
  async listClaims(): Promise<RawClaimMessage[]> { return [...this.messages]; }
  async appendClaim(raw: string): Promise<void> {
    if (this.onAppend) { this.onAppend(raw); return; }
    this.store(raw);
  }
  store(raw: string): void { this.messages.push({ ref: this.nextRef++, raw }); }
  drop(refs: readonly unknown[]): void { this.messages = this.messages.filter((m) => !refs.includes(m.ref)); }
  async removeClaims(refs: readonly unknown[]): Promise<void> { this.removals += 1; await this.onRemove(refs, this.removals); }
}

const us = (): LeaseSelf => ({ installId: "us", kind: "local", displayName: "This Mac", lastNonce: null });
const ownOld = (): string => formatClaim({
  authorizedAt: null, capabilities: [], installId: "us", kind: "local", displayName: "This Mac",
  heartbeat: ago(5_000), claimedAt: ago(600_000), nonce: "old",
});
/** A foreign claim somebody pressed for: a press outranks a live claim nobody pressed for. */
const pressed = (): string => formatClaim({
  authorizedAt: ago(1_000), capabilities: [], installId: "them", kind: "local", displayName: "Their Mac",
  heartbeat: ago(1_000), claimedAt: ago(1_000), nonce: "n-them",
});
const managed = (): RawClaimMessage => ({ ref: 101, raw: formatClaim({
  authorizedAt: null, capabilities: [], installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
  heartbeat: ago(30_000), claimedAt: ago(5 * 24 * 3_600_000), nonce: "n-managed",
}) });
const selfHosted = (): LeaseSelf => ({ installId: "ohmail-selfhost:box", kind: "cloud", displayName: "ohmail Cloud", lastNonce: null });
const takeover = { authorizedAt: NOW, intent: "takeover" as const };

describe("a failed lease release or cleanup names the error, never the mail server", () => {
  it("standing down, the release of our own claim fails", async () => {
    const d = drain();
    const io = new Folder();
    io.store(ownOld());
    io.store(pressed());
    const res = await runLeaseGate({ capabilities: [], io, self: us(), now: NOW, newNonce: () => "new", log: d.log });
    expect(res.verdict.verdict).toBe("stand_down");
    expect(io.removals).toBe(1);
    judge(d, "lease_release_failed", "remove_claims");
  });

  it("our new claim vanished and a pressed rival stands, and the release fails", async () => {
    const d = drain();
    const io = new Folder();
    io.store(ownOld());
    io.onAppend = () => { io.store(pressed()); };
    const res = await runLeaseGate({ capabilities: [], io, self: us(), now: NOW, newNonce: () => "new", log: d.log });
    expect(res.verdict.verdict).toBe("stand_down");
    expect(d.lines().map((l) => l.event)).toContain("lease_lost_race");
    judge(d, "lease_release_failed", "remove_claims");
  });

  it("the confirm loses to a pressed newcomer, and the release fails", async () => {
    const d = drain();
    const io = new Folder();
    io.store(ownOld());
    io.onAppend = (raw) => { io.store(raw); io.store(pressed()); };
    const res = await runLeaseGate({ capabilities: [], io, self: us(), now: NOW, newNonce: () => "new", log: d.log });
    expect(res.verdict.verdict).toBe("stand_down");
    judge(d, "lease_release_failed", "remove_claims");
  });

  it("a displaced claim survived the takeover, and rolling our claim back fails", async () => {
    const d = drain();
    const io = new Folder();
    io.messages.push(managed());
    io.onRemove = async (refs, call) => {
      if (call === 1) { io.drop(refs.filter((r) => r !== 101)); return; }
      throw boom();
    };
    await expect(runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover, newNonce: () => "n-us", log: d.log }))
      .rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(io.removals).toBe(2);
    judge(d, "lease_release_failed", "remove_claims");
  });

  it("an ordinary renew's cleanup fails", async () => {
    const d = drain();
    const io = new Folder();
    io.store(ownOld());
    const res = await runLeaseGate({ capabilities: [], io, self: us(), now: NOW, newNonce: () => "new", log: d.log });
    expect(res.verdict.verdict).toBe("organize");
    judge(d, "lease_cleanup_failed", "remove_claims");
  });

  it("a takeover's removal threw after it landed", async () => {
    const d = drain();
    const io = new Folder();
    io.messages.push(managed());
    io.onRemove = async (refs) => { io.drop(refs); throw boom(); };
    const res = await runLeaseGate({ capabilities: [], io, self: selfHosted(), now: NOW, takeover, newNonce: () => "n-us", log: d.log });
    expect(res.verdict.verdict).toBe("organize");
    judge(d, "lease_cleanup_failed", "remove_claims");
  });
});

const PRODUCER = { kind: "local", version: "0.0.0" };
const AT = new Date("2026-08-17T10:00:00.000Z");
const payload = (tags: string[]): OrganizerProfilePayload => ({
  screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: tags, signature: null,
});
const docAt = (at: Date, tags: string[]) => makeProfileDoc(payload(tags), { updatedAt: at, producer: PRODUCER });

class Settings implements ProfileIo {
  messages: RawProfileMessage[] = [];
  private nextRef = 1;
  tear = false;
  failRemove = false;
  async ensureMetaFolder(): Promise<void> { /* exists */ }
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m, generation: 1_000 })); }
  async appendProfile(raw: string): Promise<void> {
    const body = this.tear ? raw.replace(/\r\n\r\n[\s\S]*$/, "\r\n\r\n{ torn") : raw;
    this.messages.push({ ref: this.nextRef++, raw: body, generation: 1_000 });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    if (this.failRemove) throw boom();
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
  seed(raw: string, flags?: readonly string[]): void {
    this.messages.push({ ref: this.nextRef++, raw, generation: 1_000, ...(flags ? { flags } : {}) });
  }
}

describe("a failed settings cleanup names the error, never the mail server", () => {
  it("the tidy's removal of a superseded copy fails", async () => {
    const d = drain();
    const io = new Settings();
    io.seed(formatProfileMessage(docAt(AT, ["older"]), { installId: "i" }));
    io.seed(formatProfileMessage(docAt(new Date(AT.getTime() + 60_000), ["newer"]), { installId: "i" }));
    io.failRemove = true;
    const out = await tidyOrganizerProfile({ io, installId: "i", mode: "remove", now: new Date(AT.getTime() + 120_000), log: d.log });
    expect(out.removed).toBe(0);
    judge(d, "profile_cleanup_failed", "remove_profiles");
  });

  it("the tidy cannot mark an unseen current document as seen", async () => {
    const d = drain();
    const io = Object.assign(new Settings(), { markSeen: async (): Promise<void> => { throw boom(); } });
    io.seed(formatProfileMessage(docAt(AT, ["current"]), { installId: "i" }), []);
    await tidyOrganizerProfile({ io, installId: "i", mode: "remove", now: new Date(AT.getTime() + 60_000), log: d.log });
    judge(d, "profile_cleanup_failed", "mark_seen");
  });

  it("a write whose copy does not read back cannot remove it", async () => {
    const d = drain();
    const io = new Settings();
    io.tear = true;
    io.failRemove = true;
    const out = await writeOrganizerProfile({ io, doc: docAt(AT, ["mine"]), installId: "i", log: d.log });
    expect(out).toEqual({ written: false, reason: "append_unreadable", why: "served_malformed" });
    judge(d, "profile_cleanup_failed", "remove_profiles");
  });

  it("a write cannot remove the document it replaced", async () => {
    const d = drain();
    const io = new Settings();
    await writeOrganizerProfile({ io, doc: docAt(AT, ["first"]), installId: "i" });
    io.failRemove = true;
    const out = await writeOrganizerProfile({ io, doc: docAt(new Date(AT.getTime() + 60_000), ["second"]), installId: "i", log: d.log });
    expect(out).toEqual({ written: true, removed: 0, owed: true });
    judge(d, "profile_cleanup_failed", "remove_profiles");
  });
});
