import { describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter } from "../../src/adapters/imap.js";
import { greenmailConfig } from "./_imapenv.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";

/**
 * THE ROLE DECISIONS FOR LOCALIZED MAILBOXES, AGAINST A REAL SERVER AND THE INSTALLED IMAPFLOW.
 *
 * GreenMail advertises no SPECIAL-USE, so every role here is decided by the stored folder or a
 * name — the tier imapflow 1.7.8 changed. The fake-client file next door pins the measured lists;
 * this one runs the library that is actually installed, so a later bump that changes what the
 * adapter decides for these folder sets reddens here. Measured red on the pre-fix adapter with
 * imapflow 1.7.8 installed (2026-10-02): Sent moved to `Gesendet`, Trash to `Papierkorb`.
 */

interface Case {
  set: string;
  folders: string[];
  stored: { sent: string | null; junk: string | null; trash: string | null };
  upgrade: { sent: string; junk: string | null; trash: string | null };
  firstAttach: { sent: string; junk: string | null; trash: string | null };
}

const CASES: Case[] = [
  {
    set: "German, mixed spellings",
    folders: ["Sent", "Gesendet", "Trash", "Papierkorb", "Spam", "Junk", "Entwürfe", "Archiv"],
    stored: { sent: "Sent", junk: "Junk", trash: "Trash" },
    upgrade: { sent: "Sent", junk: "Junk", trash: "Trash" },
    firstAttach: { sent: "Sent", junk: "Junk", trash: "Trash" },
  },
  {
    set: "Italian, mixed spellings",
    folders: ["Inviati", "Posta inviata", "Cestino", "Trash", "Spam", "Indesiderata", "Bozze"],
    stored: { sent: "Inviati", junk: "Spam", trash: "Trash" },
    upgrade: { sent: "Inviati", junk: "Spam", trash: "Trash" },
    firstAttach: { sent: "Inviati", junk: "Spam", trash: "Trash" },
  },
  {
    set: "role names inside the person's own folders",
    folders: ["Sent", "Trash", "Projekte/Gesendet", "Kunden/Archiv", "Kunden/Papierkorb"],
    stored: { sent: "Sent", junk: null, trash: "Trash" },
    upgrade: { sent: "Sent", junk: null, trash: "Trash" },
    firstAttach: { sent: "Sent", junk: null, trash: "Trash" },
  },
  {
    set: "a Sent ohmail created beside the provider's Gesendet",
    folders: ["Sent", "Gesendet", "Papierkorb", "Spam"],
    stored: { sent: "Sent", junk: "Spam", trash: "Papierkorb" },
    upgrade: { sent: "Sent", junk: "Spam", trash: "Papierkorb" },
    firstAttach: { sent: "Sent", junk: "Spam", trash: "Papierkorb" },
  },
];

async function seedFolders(cfg: ImapConfig, folders: string[]): Promise<void> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    const delimiter = (await c.list()).find((f) => f.path.toUpperCase() === "INBOX")?.delimiter ?? "/";
    for (const f of folders) await c.mailboxCreate(f.split("/").join(delimiter));
  } finally {
    await c.logout();
  }
}

async function decide(cfg: ImapConfig) {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  try {
    const special = await adapter.findSpecialFolders();
    // The Sent a send files into: the send path resolves it before it looks for a copy there.
    await adapter.messageInSent("<probe@roles.invalid>");
    const sent = (await adapter.capabilities()).sentFolder;
    return { sent, junk: special.junk, trash: special.trash };
  } finally {
    await adapter.close();
  }
}

describe("[real server] localized folder roles hold across the imapflow that is installed", () => {
  for (const c of CASES) {
    it(`${c.set}: an attached mailbox keeps its roles`, async () => {
      const cfg = greenmailConfig();
      await seedFolders(cfg, c.folders);
      expect(await decide({ ...cfg, storedFolders: c.stored })).toEqual(c.upgrade);
    });

    it(`${c.set}: a first attach decides as 0.25.8 did`, async () => {
      const cfg = greenmailConfig();
      await seedFolders(cfg, c.folders);
      expect(await decide(cfg)).toEqual(c.firstAttach);
    });
  }
});
