import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImapAdapter } from "../../src/adapters/imap.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import {
  makeProfileDoc, readOrganizerProfile, writeOrganizerProfile,
  type OrganizerProfilePayload, type ProfilePreferences,
} from "../../src/adapters/organizer-profile.js";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "./_imapenv.js";

/**
 * WHAT A PERSON STATED, IN A SETTINGS MESSAGE A REAL SERVER STORED. The in-process mail server
 * keeps the bytes it was handed; a real one may store them otherwise. A copy that states a pair is
 * written through one connection and read back through another, on GreenMail and on Dovecot: the
 * pair comes back the same, the copy still reads as written, and a later copy that states nothing
 * reads as nothing stated. The in-process twin is `apps/sidecar/test/profile-preferences-round-trip.test.ts`.
 */
vi.setConfig({ testTimeout: 30_000 });

function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true, why: "" },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok, why: CONDSTORE.ok ? "" : CONDSTORE.why },
];

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c.close().catch(() => { /* already down */ });
});

async function connected(cfg: ImapConfig): Promise<ImapAdapter> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  open.push(adapter);
  return adapter;
}

const PAYLOAD: OrganizerProfilePayload = {
  screener: [{ address: "anna@example.org", name: "Änne Müller" }], rules: [], notifyRules: [], awayResponder: null,
  tagNames: ["Töpferei"], signature: "Grüße aus Basel",
};
const STATED: ProfilePreferences = { subject: { value: "each", at: "2026-10-11T07:30:00.123Z" } };

for (const server of SERVERS) {
  if (!server.enabled) {
    console.warn(`\n[condstore] SKIPPING the stated pair in a stored settings message against ${server.name} — ${server.why}\n`);
    describe(`what a person stated, in a stored settings message (${server.name})`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
    continue;
  }

  describe(`what a person stated, in a stored settings message (${server.name})`, () => {
    it("is read back by another connection as it was written, and a later copy without it states nothing", async () => {
      const cfg = server.config();
      const writer = await connected(cfg);
      const installId = `writer-${randomUUID()}`;
      const mailboxId = "stated-pair";
      await writer.profileIo({ installId, mailboxId }).ensureMetaFolder();
      const doc = makeProfileDoc(PAYLOAD, { updatedAt: new Date("2026-10-12T08:00:00.000Z"), producer: { kind: "local", version: "test" }, preferences: STATED });
      expect((await writeOrganizerProfile({ io: writer.profileIo({ installId, mailboxId }), doc, installId })).written).toBe(true);

      const reader = await connected(cfg);
      const read = await readOrganizerProfile(reader.profileIo({ installId: `reader-${randomUUID()}`, mailboxId }));
      expect(read.state).toBe("found");
      if (read.state !== "found") return;
      expect(read.installId).toBe(installId);
      expect(read.doc.preferences).toEqual(STATED);
      expect(read.doc.tagNames).toEqual(PAYLOAD.tagNames);
      // The server stored what it was sent: the holder owes no rewrite of it.
      expect(read.encoded).not.toBe(false);

      // The next copy states nothing, as a writer that does not know the key leaves it: read back, nothing is stated.
      const next = makeProfileDoc({ ...PAYLOAD, tagNames: ["Töpferei", "Brennofen"] }, {
        updatedAt: new Date("2026-10-12T09:00:00.000Z"), producer: { kind: "local", version: "test" }, preferences: {},
      });
      expect((await writeOrganizerProfile({ io: writer.profileIo({ installId, mailboxId }), doc: next, installId })).written).toBe(true);
      // Through a fresh connection: a session that had the folder open learns of the removed copy only later.
      const again = await connected(cfg);
      const after = await readOrganizerProfile(again.profileIo({ installId: `reader-${randomUUID()}`, mailboxId }));
      expect(after.state).toBe("found");
      if (after.state !== "found") return;
      expect(after.doc.tagNames).toEqual(["Brennofen", "Töpferei"]);
      expect("preferences" in after.doc).toBe(false);
    });
  });
}
