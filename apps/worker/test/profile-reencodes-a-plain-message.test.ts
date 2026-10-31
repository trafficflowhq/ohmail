import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, tags, type Tx } from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { readOrganizerScreening, serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { OrganizerProfileSync } from "../src/profile.js";

/**
 * A SETTINGS MESSAGE WRITTEN BEFORE THE ESCAPES IS REWRITTEN ONCE BY THE HOLDER.
 *
 * A plain message (names as text, `JSON.stringify` layout) saying exactly what the holder's store
 * says is rewritten once in the escaped form; the fingerprint does not move and the next pass
 * writes nothing. A server that stores different bytes than it was sent costs one write, not one
 * per pass. An escaped message is never rewritten, and a reader never reaches the pass.
 */
const PERSON = "Ada Lovelace";

/** The plain form shipped builds wrote: the same message with the document as `JSON.stringify`. */
function plainOf(escaped: string, doc: unknown): string {
  return `${escaped.slice(0, escaped.indexOf("{"))}${JSON.stringify(doc, null, 2)}\r\n`;
}

class ProfileFolder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  appends = 0;
  next = 1;
  /** A server that stores the document plain whatever it was sent — the re-encode loop's shape. */
  normalises = false;
  async ensureMetaFolder(): Promise<void> { /* the folder exists */ }
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.messages.map((m) => ({ ...m, generation: 7 }));
  }
  async appendProfile(raw: string): Promise<void> {
    this.appends += 1;
    const stored = this.normalises ? (() => {
      const parsed = parseProfileMessage(raw);
      return parsed !== null && !isMalformedProfile(parsed) ? plainOf(raw, JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1))) : raw;
    })() : raw;
    this.messages.push({ ref: this.next++, raw: stored, generation: 7 });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.messages = this.messages.filter((m) => !refs.includes(m.ref));
  }
}

async function rig(o: { form: "plain" | "escaped"; normalises?: boolean }) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "reencode", createdAt: new Date("2026-01-01T00:00:00Z") });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning({ id: mailboxes.id });
  const mailboxId = mb!.id;
  await db.insert(tags).values({ accountId, name: PERSON });
  const payload = await serializeOrganizerProfile(db, accountId, mailboxId);
  // The copy states the window this store publishes (RULING-026), so the only difference a pass can
  // find is the encoding; a copy without the window is published once on that account instead.
  const screening = await readOrganizerScreening(db, accountId);
  const doc = makeProfileDoc(payload, { updatedAt: new Date("2026-09-20T08:00:00Z"), producer: { kind: "cloud", version: "0.25.4" }, screening });
  const escaped = formatProfileMessage(doc, { installId: "this-install" });
  const folder = new ProfileFolder();
  folder.normalises = o.normalises === true;
  folder.messages.push({ ref: folder.next++, raw: o.form === "plain" ? plainOf(escaped, doc) : escaped, generation: 7 });
  let clock = Date.parse("2026-10-02T08:00:00Z");
  const lines: string[] = [];
  const sync = new OrganizerProfileSync({
    db, accountId, mailboxId,
    adapter: { profileIo: () => folder } as unknown as MailboxAdapter,
    self: { installId: "this-install", kind: "cloud" },
    producerVersion: "test",
    flushIntervalMs: 1_000,
    now: () => new Date(clock),
    log: (event) => { lines.push(event); },
  });
  const tick = async (): Promise<void> => { clock += 60_000; await sync.onOrganize(); };
  return { sync, folder, doc, lines, tick };
}

const settingsMessages = (f: ProfileFolder): string[] =>
  f.messages.map((m) => m.raw).filter((raw) => /^X-Ohmail-Profile: 1/m.test(raw));

describe("the holder rewrites a plain settings message once", () => {
  it("one write, the fingerprint unchanged, encoded on the next read, nothing on the passes after", async () => {
    const r = await rig({ form: "plain" });
    expect(settingsMessages(r.folder)[0]).toContain(PERSON);
    for (let i = 0; i < 4; i++) await r.tick();
    expect(r.folder.appends, r.lines.join(",")).toBe(1);
    expect(r.lines.filter((e) => e === "profile_reencoded")).toHaveLength(1);
    const now = settingsMessages(r.folder);
    expect(now).toHaveLength(1);
    expect(now[0], "a person's name is still plain text in the message").not.toContain(PERSON);
    const parsed = parseProfileMessage(now[0]!);
    expect(parsed !== null && !isMalformedProfile(parsed) && parsed.encoded).toBe(true);
    expect(parsed !== null && !isMalformedProfile(parsed) ? profileFingerprint(parsed.doc!) : null).toBe(profileFingerprint(r.doc));
  });

  it("a server that stores the document plain costs one write, not one per pass", async () => {
    const r = await rig({ form: "plain", normalises: true });
    for (let i = 0; i < 5; i++) await r.tick();
    expect(r.folder.appends).toBe(1);
  });

  it("an escaped message is never rewritten", async () => {
    const r = await rig({ form: "escaped" });
    for (let i = 0; i < 4; i++) await r.tick();
    expect(r.folder.appends).toBe(0);
    expect(r.lines).not.toContain("profile_reencoded");
  });
});

/**
 * A READER NEVER REACHES THE PASS: the re-encode lives in `onOrganize`, and both hosts call it on
 * the organizing arm only. A census over the two call sites, read with comments blanked.
 * @reads: apps/worker/src/index.ts apps/sidecar/src/engine.ts
 */
describe("the census: onOrganize is called on the organizing arm only", () => {
  it("the worker and the sidecar gate their one call on the role", () => {
    /* Call sites found with comments and literals blanked; the gate read off the same raw line. */
    const calls = (rel: string): string[] => {
      const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      const code = withoutCommentsAndLiterals(raw).split("\n");
      const lines = raw.split("\n");
      return code.flatMap((l, i) => (/\.onOrganize\(/.test(l) ? [lines[i]!] : []));
    };
    const worker = calls("../src/index.ts");
    const sidecar = calls("../../sidecar/src/engine.ts");
    expect(worker).toHaveLength(1);
    expect(worker[0]).toMatch(/if \(rt\.role === "organizer" &&/);
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]).toMatch(/if \(organizing &&/);
  });
});
