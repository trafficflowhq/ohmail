import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../../src/adapters/imap.js";

/**
 * THE ROLE DECISIONS OF 0.25.8, PINNED OVER THE LISTS TWO IMAPFLOW VERSIONS RETURN.
 *
 * Each row is one folder set MEASURED on Dovecot 2.3.21 (SPECIAL-USE off and on, 2026-10-02):
 * the folders, the server's own flags, and the `specialUse` winner imapflow 1.5.0 (`v150`) and
 * 1.7.8 (`v178`) each reported. `was` is what the 1.5.0 adapter decided. 1.7.8 guesses from
 * localized names 1.5.0 never knew and breaks ties by alphabet, so on the old adapter ten of
 * the twenty sets moved: Sent from `Sent` to `Gesendet`, Trash into `Kunden/Papierkorb`, …
 * The fake reports a version's list verbatim; the adapter must decide the same either way.
 */

type Shape = [string, string];
interface Row {
  set: string;
  /** The server advertised SPECIAL-USE. Absent: read from the set's name, `on-` alone did. */
  specialUseCap?: boolean;
  folders: { path: string; flags?: string[]; v150?: Shape; v178?: Shape }[];
  was: {
    sentAtConnect: string | null; scanSent: string | null; writeSent: string; created: string[];
    junk: string | null; trash: string | null; passiveRead: string[];
  };
  /** The pre-fix adapter on 1.7.8; measured for the twenty, absent for the Exchange rows. */
  v178?: { writeSent: string; junk: string | null; trash: string | null };
}

const ROWS_MEASURED: Row[] = [
  {"set":"off-en","folders":[{"path":"Sent","v150":["\\Sent","name"],"v178":["\\Sent","name"]},{"path":"Trash","v150":["\\Trash","name"],"v178":["\\Trash","name"]},{"path":"Junk","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Drafts","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archive","v150":["\\Archive","name"],"v178":["\\Archive","name"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Junk","trash":"Trash","passiveRead":["Archive"]},"v178":{"writeSent":"Sent","junk":"Junk","trash":"Trash"}},
  {"set":"off-de-gmx","folders":[{"path":"Gesendet","v178":["\\Sent","name"]},{"path":"Gelöscht","v178":["\\Trash","name"]},{"path":"Spamverdacht"},{"path":"Entwürfe","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archiv","v178":["\\Archive","name"]}],"was":{"sentAtConnect":null,"scanSent":null,"writeSent":"Sent","created":["Sent"],"junk":null,"trash":null,"passiveRead":["Archiv","Gelöscht","Gesendet","Spamverdacht"]},"v178":{"writeSent":"Gesendet","junk":null,"trash":"Gelöscht"}},
  {"set":"off-de-thunderbird","folders":[{"path":"Gesendet","v178":["\\Sent","name"]},{"path":"Papierkorb","v178":["\\Trash","name"]},{"path":"Junk","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Entwürfe","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archiv","v178":["\\Archive","name"]}],"was":{"sentAtConnect":null,"scanSent":null,"writeSent":"Sent","created":["Sent"],"junk":"Junk","trash":"Papierkorb","passiveRead":["Archiv","Gesendet"]},"v178":{"writeSent":"Gesendet","junk":"Junk","trash":"Papierkorb"}},
  {"set":"off-de-exchange","folders":[{"path":"Gesendete Elemente","v150":["\\Sent","name"],"v178":["\\Sent","name"]},{"path":"Gelöschte Elemente","v150":["\\Trash","name"],"v178":["\\Trash","name"]},{"path":"Junk-E-Mail","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Entwürfe","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archiv","v178":["\\Archive","name"]}],"was":{"sentAtConnect":"Gesendete Elemente","scanSent":"Gesendete Elemente","writeSent":"Gesendete Elemente","created":[],"junk":"Junk-E-Mail","trash":"Gelöschte Elemente","passiveRead":["Archiv"]},"v178":{"writeSent":"Gesendete Elemente","junk":"Junk-E-Mail","trash":"Gelöschte Elemente"}},
  {"set":"off-de-mixed","folders":[{"path":"Sent","v150":["\\Sent","name"]},{"path":"Gesendet","v178":["\\Sent","name"]},{"path":"Trash","v150":["\\Trash","name"]},{"path":"Papierkorb","v178":["\\Trash","name"]},{"path":"Spam"},{"path":"Junk","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Entwürfe","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archiv","v178":["\\Archive","name"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Junk","trash":"Trash","passiveRead":["Archiv","Gesendet"]},"v178":{"writeSent":"Gesendet","junk":"Junk","trash":"Papierkorb"}},
  {"set":"off-fr","folders":[{"path":"Envoyés","v150":["\\Sent","name"],"v178":["\\Sent","name"]},{"path":"Corbeille","v178":["\\Trash","name"]},{"path":"Indésirables","v178":["\\Junk","name"]},{"path":"Brouillons","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archives","v178":["\\Archive","name"]}],"was":{"sentAtConnect":"Envoyés","scanSent":"Envoyés","writeSent":"Envoyés","created":[],"junk":null,"trash":null,"passiveRead":["Archives","Corbeille","Indésirables"]},"v178":{"writeSent":"Envoyés","junk":"Indésirables","trash":"Corbeille"}},
  {"set":"off-fr-outlook","folders":[{"path":"Éléments envoyés","v150":["\\Sent","name"],"v178":["\\Sent","name"]},{"path":"Éléments supprimés","v150":["\\Trash","name"],"v178":["\\Trash","name"]},{"path":"Courrier indésirable","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Brouillons","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archives","v178":["\\Archive","name"]}],"was":{"sentAtConnect":"Éléments envoyés","scanSent":"Éléments envoyés","writeSent":"Éléments envoyés","created":[],"junk":"Courrier indésirable","trash":"Éléments supprimés","passiveRead":["Archives"]},"v178":{"writeSent":"Éléments envoyés","junk":"Courrier indésirable","trash":"Éléments supprimés"}},
  {"set":"off-it","folders":[{"path":"Posta inviata","v178":["\\Sent","name"]},{"path":"Cestino","v178":["\\Trash","name"]},{"path":"Posta indesiderata","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Bozze","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]},{"path":"Archivio","v178":["\\Archive","name"]}],"was":{"sentAtConnect":null,"scanSent":null,"writeSent":"Sent","created":["Sent"],"junk":"Posta indesiderata","trash":null,"passiveRead":["Archivio","Cestino","Posta inviata"]},"v178":{"writeSent":"Posta inviata","junk":"Posta indesiderata","trash":"Cestino"}},
  {"set":"off-it-mixed","folders":[{"path":"Inviati","v150":["\\Sent","name"],"v178":["\\Sent","name"]},{"path":"Posta inviata"},{"path":"Cestino","v178":["\\Trash","name"]},{"path":"Trash","v150":["\\Trash","name"]},{"path":"Spam","v150":["\\Junk","name"]},{"path":"Indesiderata","v178":["\\Junk","name"]},{"path":"Bozze","v150":["\\Drafts","name"],"v178":["\\Drafts","name"]}],"was":{"sentAtConnect":"Inviati","scanSent":"Inviati","writeSent":"Inviati","created":[],"junk":"Spam","trash":"Trash","passiveRead":["Cestino","Indesiderata","Posta inviata"]},"v178":{"writeSent":"Inviati","junk":"Indesiderata","trash":"Cestino"}},
  {"set":"off-mixed-nested","folders":[{"path":"Kunden","flags":["\\Noselect"]},{"path":"Projekte","flags":["\\Noselect"]},{"path":"Sent","v150":["\\Sent","name"]},{"path":"Trash","v150":["\\Trash","name"]},{"path":"Projekte/Gesendet","v178":["\\Sent","name"]},{"path":"Kunden/Archiv","v178":["\\Archive","name"]},{"path":"Kunden/Papierkorb","v178":["\\Trash","name"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":null,"trash":"Trash","passiveRead":["Kunden/Archiv","Projekte/Gesendet"]},"v178":{"writeSent":"Projekte/Gesendet","junk":null,"trash":"Kunden/Papierkorb"}},
  {"set":"off-user-names","folders":[{"path":"Sent Mail"},{"path":"Sent","v150":["\\Sent","name"],"v178":["\\Sent","name"]},{"path":"Trash","v150":["\\Trash","name"],"v178":["\\Trash","name"]},{"path":"Spam","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Archiv 2023"},{"path":"Gesendet an Kunden"},{"path":"Tramess"}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Spam","trash":"Trash","passiveRead":["Archiv 2023","Gesendet an Kunden","Sent Mail","Tramess"]},"v178":{"writeSent":"Sent","junk":"Spam","trash":"Trash"}},
  {"set":"off-ohmail-made-sent","folders":[{"path":"Sent","v150":["\\Sent","name"]},{"path":"Gesendet","v178":["\\Sent","name"]},{"path":"Papierkorb","v178":["\\Trash","name"]},{"path":"Spam","v150":["\\Junk","name"],"v178":["\\Junk","name"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Spam","trash":"Papierkorb","passiveRead":["Gesendet"]},"v178":{"writeSent":"Gesendet","junk":"Spam","trash":"Papierkorb"}},
  {"set":"on-en","folders":[{"path":"Sent","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Trash","flags":["\\Trash"],"v150":["\\Trash","extension"],"v178":["\\Trash","extension"]},{"path":"Junk","flags":["\\Junk"],"v150":["\\Junk","extension"],"v178":["\\Junk","extension"]},{"path":"Drafts","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Archive","flags":["\\Archive"],"v150":["\\Archive","extension"],"v178":["\\Archive","extension"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Junk","trash":"Trash","passiveRead":["Archive"]},"v178":{"writeSent":"Sent","junk":"Junk","trash":"Trash"}},
  {"set":"on-de-exchange","folders":[{"path":"Gesendete Elemente","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Gelöschte Elemente","flags":["\\Trash"],"v150":["\\Trash","extension"],"v178":["\\Trash","extension"]},{"path":"Junk-E-Mail","flags":["\\Junk"],"v150":["\\Junk","extension"],"v178":["\\Junk","extension"]},{"path":"Entwürfe","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Archive","flags":["\\Archive"],"v150":["\\Archive","extension"],"v178":["\\Archive","extension"]}],"was":{"sentAtConnect":"Gesendete Elemente","scanSent":"Gesendete Elemente","writeSent":"Gesendete Elemente","created":[],"junk":"Junk-E-Mail","trash":"Gelöschte Elemente","passiveRead":["Archive"]},"v178":{"writeSent":"Gesendete Elemente","junk":"Junk-E-Mail","trash":"Gelöschte Elemente"}},
  {"set":"on-de-flags-en-user-de","folders":[{"path":"Sent","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Trash","flags":["\\Trash"],"v150":["\\Trash","extension"],"v178":["\\Trash","extension"]},{"path":"Junk","flags":["\\Junk"],"v150":["\\Junk","extension"],"v178":["\\Junk","extension"]},{"path":"Drafts","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Gesendet"},{"path":"Papierkorb"},{"path":"Spam"},{"path":"Archiv","v178":["\\Archive","name"]},{"path":"Gelöscht"}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Junk","trash":"Trash","passiveRead":["Archiv","Gelöscht","Gesendet"]},"v178":{"writeSent":"Sent","junk":"Junk","trash":"Trash"}},
  {"set":"on-de-exchange-user-de","folders":[{"path":"Gesendete Elemente","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Gelöschte Elemente","flags":["\\Trash"],"v150":["\\Trash","extension"],"v178":["\\Trash","extension"]},{"path":"Junk-E-Mail","flags":["\\Junk"],"v150":["\\Junk","extension"],"v178":["\\Junk","extension"]},{"path":"Entwürfe","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Gesendet"},{"path":"Papierkorb"},{"path":"Spam"},{"path":"Archiv","v178":["\\Archive","name"]}],"was":{"sentAtConnect":"Gesendete Elemente","scanSent":"Gesendete Elemente","writeSent":"Gesendete Elemente","created":[],"junk":"Junk-E-Mail","trash":"Gelöschte Elemente","passiveRead":["Archiv","Gesendet"]},"v178":{"writeSent":"Gesendete Elemente","junk":"Junk-E-Mail","trash":"Gelöschte Elemente"}},
  {"set":"on-fr","folders":[{"path":"Éléments envoyés","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Éléments supprimés","flags":["\\Trash"],"v150":["\\Trash","extension"],"v178":["\\Trash","extension"]},{"path":"Courrier indésirable","flags":["\\Junk"],"v150":["\\Junk","extension"],"v178":["\\Junk","extension"]},{"path":"Brouillons","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Archives","flags":["\\Archive"],"v150":["\\Archive","extension"],"v178":["\\Archive","extension"]},{"path":"Corbeille"},{"path":"Indésirables"},{"path":"Envoyés"}],"was":{"sentAtConnect":"Éléments envoyés","scanSent":"Éléments envoyés","writeSent":"Éléments envoyés","created":[],"junk":"Courrier indésirable","trash":"Éléments supprimés","passiveRead":["Archives","Corbeille","Envoyés","Indésirables"]},"v178":{"writeSent":"Éléments envoyés","junk":"Courrier indésirable","trash":"Éléments supprimés"}},
  {"set":"on-it","folders":[{"path":"Posta inviata","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Posta eliminata","flags":["\\Trash"],"v150":["\\Trash","extension"],"v178":["\\Trash","extension"]},{"path":"Posta indesiderata","flags":["\\Junk"],"v150":["\\Junk","extension"],"v178":["\\Junk","extension"]},{"path":"Bozze","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Archivio","flags":["\\Archive"],"v150":["\\Archive","extension"],"v178":["\\Archive","extension"]},{"path":"Cestino"},{"path":"Indesiderata"},{"path":"Inviata"}],"was":{"sentAtConnect":"Posta inviata","scanSent":"Posta inviata","writeSent":"Posta inviata","created":[],"junk":"Posta indesiderata","trash":"Posta eliminata","passiveRead":["Archivio","Cestino","Indesiderata","Inviata"]},"v178":{"writeSent":"Posta inviata","junk":"Posta indesiderata","trash":"Posta eliminata"}},
  {"set":"on-partial-sent-only","folders":[{"path":"Sent","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Papierkorb"},{"path":"Spam","v150":["\\Junk","name"],"v178":["\\Junk","name"]},{"path":"Entwürfe","flags":["\\Drafts"],"v150":["\\Drafts","extension"],"v178":["\\Drafts","extension"]},{"path":"Archiv","v178":["\\Archive","name"]},{"path":"Gelöscht","v178":["\\Trash","name"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Spam","trash":"Papierkorb","passiveRead":["Archiv","Gelöscht"]},"v178":{"writeSent":"Sent","junk":"Spam","trash":"Gelöscht"}},
  {"set":"on-partial-de-unflagged","folders":[{"path":"Sent","flags":["\\Sent"],"v150":["\\Sent","extension"],"v178":["\\Sent","extension"]},{"path":"Gesendet"},{"path":"Cestino","v178":["\\Trash","name"]},{"path":"Corbeille"},{"path":"Indesiderata","v178":["\\Junk","name"]}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":null,"trash":null,"passiveRead":["Cestino","Corbeille","Gesendet","Indesiderata"]},"v178":{"writeSent":"Sent","junk":"Indesiderata","trash":"Cestino"}},
];

/**
 * EXCHANGE'S SHAPE: RFC 6154 role attributes in a plain LIST from a session that advertises neither
 * SPECIAL-USE nor XLIST. imapflow 1.5.0 read no flag there and guessed by name, so 0.25.8 used `Sent`
 * beside a flagged `Sent Items`. Measured by that change on a Dovecot that sends
 * the attributes without the capability (rev026isu-dovecot-exch, 2026-10-02); red at DONE-2, where
 * the adapter read the flags whatever the session advertised and moved Sent and Junk.
 */
const ROWS_EXCHANGE: Row[] = [
  {"set":"exch-en","specialUseCap":false,"folders":[{"path":"Sent Items","flags":["\\Sent"],"v150":["\\Sent","measured"],"v178":["\\Sent","measured"]},{"path":"Drafts","flags":["\\Drafts"],"v150":["\\Drafts","measured"],"v178":["\\Drafts","measured"]},{"path":"Archive","flags":["\\Archive"],"v150":["\\Archive","measured"],"v178":["\\Archive","measured"]},{"path":"Junk Email","flags":["\\Junk"],"v150":["\\Junk","measured"],"v178":["\\Junk","measured"]},{"path":"Deleted Items","flags":["\\Trash"],"v150":["\\Trash","measured"],"v178":["\\Trash","measured"]}],"was":{"sentAtConnect":"Sent Items","scanSent":"Sent Items","writeSent":"Sent Items","created":[],"junk":"Junk Email","trash":"Deleted Items","passiveRead":["Archive"]}},
  {"set":"exch-en-plus","specialUseCap":false,"folders":[{"path":"Sent","v150":["\\Sent","measured"],"v178":["\\Sent","measured"]},{"path":"Drafts","flags":["\\Drafts"],"v150":["\\Drafts","measured"],"v178":["\\Drafts","measured"]},{"path":"Archive","flags":["\\Archive"],"v150":["\\Archive","measured"],"v178":["\\Archive","measured"]},{"path":"Junk","v150":["\\Junk","measured"],"v178":["\\Junk","measured"]},{"path":"Deleted Items","flags":["\\Trash"],"v150":["\\Trash","measured"],"v178":["\\Trash","measured"]},{"path":"Junk Email","flags":["\\Junk"]},{"path":"Sent Items","flags":["\\Sent"]},{"path":"Trash"}],"was":{"sentAtConnect":"Sent","scanSent":"Sent","writeSent":"Sent","created":[],"junk":"Junk","trash":"Deleted Items","passiveRead":["Archive","Sent Items"]}},
  {"set":"exch-de","specialUseCap":false,"folders":[{"path":"Gesendete Elemente","flags":["\\Sent"],"v150":["\\Sent","measured"],"v178":["\\Sent","measured"]},{"path":"Entwürfe","flags":["\\Drafts"],"v150":["\\Drafts","measured"],"v178":["\\Drafts","measured"]},{"path":"Archive","flags":["\\Archive"],"v150":["\\Archive","measured"],"v178":["\\Archive","measured"]},{"path":"Junk-E-Mail","flags":["\\Junk"],"v150":["\\Junk","measured"],"v178":["\\Junk","measured"]},{"path":"Gelöschte Elemente","flags":["\\Trash"],"v150":["\\Trash","measured"],"v178":["\\Trash","measured"]}],"was":{"sentAtConnect":"Gesendete Elemente","scanSent":"Gesendete Elemente","writeSent":"Gesendete Elemente","created":[],"junk":"Junk-E-Mail","trash":"Gelöschte Elemente","passiveRead":["Archive"]}},
  {"set":"exch-de-plus","specialUseCap":false,"folders":[{"path":"Gesendete","v150":["\\Sent","measured"],"v178":["\\Sent","measured"]},{"path":"Entwürfe","flags":["\\Drafts"],"v150":["\\Drafts","measured"],"v178":["\\Drafts","measured"]},{"path":"Junk-E-Mail","flags":["\\Junk"],"v150":["\\Junk","measured"],"v178":["\\Junk","measured"]},{"path":"Deleted Items","flags":["\\Trash"],"v150":["\\Trash","measured"],"v178":["\\Trash","measured"]},{"path":"Gelöschte Elemente","flags":["\\Trash"]},{"path":"Gesendete Elemente","flags":["\\Sent"]},{"path":"Sent"},{"path":"Spam"},{"path":"Trash"}],"was":{"sentAtConnect":"Gesendete","scanSent":"Gesendete","writeSent":"Gesendete","created":[],"junk":"Junk-E-Mail","trash":"Deleted Items","passiveRead":["Gesendete Elemente","Sent"]}},
];

const ROWS: Row[] = [
  ...ROWS_MEASURED.map((r) => ({ ...r, specialUseCap: r.set.startsWith("on-") })),
  ...ROWS_EXCHANGE,
];

function fakeClient(row: Row, version: "v150" | "v178") {
  const folders = [{ path: "INBOX", flags: [] as string[], v150: ["\\Inbox", "name"], v178: ["\\Inbox", "name"] }, ...row.folders];
  const created: string[] = [];
  const locked: string[] = [];
  return {
    created,
    locked,
    // What the measured server advertised: the `on-` Dovecot SPECIAL-USE, the others nothing.
    capabilities: new Map<string, boolean>([["IDLE", true], ...(row.specialUseCap ? [["SPECIAL-USE", true] as [string, boolean]] : [])]),
    mailbox: false as const,
    async list() {
      return folders.map((f) => {
        const won = (f as Record<string, unknown>)[version] as Shape | undefined;
        return {
          path: f.path, name: f.path.split("/").pop()!, delimiter: "/",
          flags: new Set(f.flags ?? []),
          ...(won ? { specialUse: won[0], specialUseSource: won[1] } : {}),
        };
      });
    },
    async mailboxCreate(path: string) { created.push(path); folders.push({ path, flags: [] }); return { path }; },
    async getMailboxLock(path: string) { locked.push(path); return { path, release() {} }; },
    async search() { return [] as number[]; },
    async logout() { /* nothing to tear down */ },
    close() { /* nothing to tear down */ },
  };
}

type Stored = { sent: string | null; junk: string | null; trash: string | null } | undefined;

async function decide(row: Row, version: "v150" | "v178", stored: Stored) {
  const client = fakeClient(row, version);
  const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" }, ...(stored ? { storedFolders: stored } : {}) };
  const adapter = new ImapAdapter(cfg, { client });
  await adapter.connect();
  // Each role read where the adapter states or uses it: the Sent of the connect, the folder the
  // scan opens (on this fake's `/` the server path is the folder's own), and the Sent a send files
  // into (the send path resolves it before it looks for a copy there).
  const sentAtConnect = (await adapter.capabilities()).sentFolder ?? null;
  const special = await adapter.findSpecialFolders();
  const lockedBefore = client.locked.length;
  await adapter.scanSentRecipients(1);
  const scanSent = client.locked[lockedBefore] ?? null;
  const passiveRead = [...adapter.passiveFolderReport().read];
  await adapter.messageInSent("<probe@roles.invalid>");
  const writeSent = (await adapter.capabilities()).sentFolder;
  return {
    sentAtConnect, scanSent, writeSent, created: client.created,
    junk: special.junk, trash: special.trash, passiveRead,
  };
}

/** What 0.25.8 wrote down at its last attach — the folder a role must not move away from. */
const storedBy = (row: Row): Stored => ({ sent: row.was.scanSent, junk: row.was.junk, trash: row.was.trash });

describe("folder roles on upgrade — a mailbox 0.25.8 attached decides exactly as it did", () => {
  for (const row of ROWS) {
    it(`${row.set}: the 1.7.8 list moves nothing`, async () => {
      expect(await decide(row, "v178", storedBy(row))).toEqual(row.was);
      expect(await decide(row, "v150", storedBy(row))).toEqual(row.was);
    });
  }

  it("the fixture holds the measured moves (the subject has the property under test)", () => {
    const moved = ROWS.filter((r) => r.v178 && (r.v178.writeSent !== r.was.writeSent
      || r.v178.junk !== r.was.junk || r.v178.trash !== r.was.trash)).map((r) => r.set);
    expect(moved).toEqual([
      "off-de-gmx", "off-de-thunderbird", "off-de-mixed", "off-fr", "off-it", "off-it-mixed",
      "off-mixed-nested", "off-ohmail-made-sent", "on-partial-sent-only", "on-partial-de-unflagged",
    ]);
  });
});

/**
 * A FIRST ATTACH has nothing stored, so a name answers — from the PINNED table, never the
 * library's, tied as 0.25.8 tied it. Every set then decides exactly as 0.25.8 did, on either list.
 */
describe("folder roles on a first attach — exactly 0.25.8's decision, with either imapflow", () => {
  for (const row of ROWS) {
    it(`${row.set}`, async () => {
      expect(await decide(row, "v178", undefined)).toEqual(row.was);
      expect(await decide(row, "v150", undefined)).toEqual(row.was);
    });
  }

  it("Trash+Papierkorb and Junk+Spam decide exactly as imapflow 1.5.0 did — no new refusal", async () => {
    const row = ROWS.find((r) => r.set === "off-de-mixed")!;
    const won = (flag: string) => row.folders.find((f) => f.v150?.[0] === flag)?.path ?? null;
    expect(row.folders.map((f) => f.path)).toEqual(expect.arrayContaining(["Trash", "Papierkorb", "Junk", "Spam"]));
    const got = await decide(row, "v178", undefined);
    expect({ junk: got.junk, trash: got.trash }).toEqual({ junk: won("\\Junk"), trash: won("\\Trash") });
    expect(got.trash).not.toBeNull();
    expect(got.junk).not.toBeNull();
  });
});
