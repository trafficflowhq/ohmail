import type { Destination } from "./types.js";
/**
 * The port lives in `ports.ts`, not here, and the direction of that import is the point.
 * `FolderScanner` is two read-only methods over any mailbox, and `ImapAdapter` implements it
 * beside the other ports declared there. Declared HERE — in the migration that happens to be its
 * first consumer — the IMAP adapter, mail-half code, named this module in an import on every
 * build purely to say what shape it satisfies: a type-only edge, invisible in the emitted
 * JavaScript and perfectly visible in the source, making a private migration a declared
 * dependency of the adapter. Nothing is re-exported from this file: `index.ts` re-exports both
 * modules with `export *`, and one name arriving from two of them is an ambiguity.
 */
import type { FolderScanner } from "./ports.js";

/**
 * HEY-migration folder-scan (spec §16). Seeds the deterministic ruleset from an EXISTING
 * mailbox's own placement: enumerate the server's folders, sample each folder's senders, and map
 * every real server folder to one of our canonical {@link Destination}s. Each sampled sender
 * becomes a `{ senderOrDomain, kind, destination }` observation that
 * `HeyMigrationService.migrateFromObservations` turns into a `provenance:'migrated'` rule.
 * Expressed against the narrow {@link FolderScanner} port so it is testable against a real IMAP
 * server and a deterministic mock alike; a HEY-data-export parser can plug into the same
 * `MigrationObservation[]` shape later — this is that seam.
 */

export interface MigrationObservation {
  senderOrDomain: string;             // the sender address (kind='sender') or domain (kind='domain')
  kind: "sender" | "domain";
  destination: Destination;           // the mapped canonical folder
}

/** Map a real (canonical) server-folder path to a canonical Destination, or `null` to SKIP it. */
export type FolderMapper = (serverFolder: string) => Destination | null;

export interface ScanOptions {
  /** Folder → Destination mapping. Defaults to {@link defaultFolderMapper}. */
  mapFolder?: FolderMapper;
  /** Max senders sampled per folder (default 50). */
  sampleLimit?: number;
  /** Observation granularity (default 'sender'). */
  kind?: "sender" | "domain";
}

const domainOf = (addr: string): string => {
  const i = addr.indexOf("@");
  return i >= 0 ? addr.slice(i + 1).toLowerCase() : "";
};

/**
 * Default folder → Destination mapping. `INBOX` → `INBOX` (senders already filed here are
 * approved). Our own `ohmail/*` management folders are SKIPPED: re-deriving rules from the
 * folders WE placed mail into would be circular, and Screener/Quarantine are transient holding
 * areas, not user intent. Common HEY and user folder names map by keyword to
 * Reads/Receipts/Screened. Mail-plumbing folders (Sent/Drafts/Trash/Archive) are skipped — they
 * carry no classification intent. Anything unrecognized is skipped, so migration never invents a
 * rule from a folder whose meaning we cannot infer.
 */
export function defaultFolderMapper(serverFolder: string): Destination | null {
  const f = serverFolder.trim();
  const upper = f.toUpperCase();
  if (upper === "INBOX") return "INBOX";

  // Skip our own management namespace outright (circular / transient).
  if (/^ohmail\//i.test(f)) return null;

  const leaf = f.split("/").pop()!.toLowerCase();

  // Mail-plumbing folders carry no classification intent.
  if (/^(sent|drafts?|trash|deleted|archive|outbox|templates?|notes)$/i.test(leaf)) return null;

  if (/spam|junk|quarantine/i.test(leaf)) return "ohmail/Quarantine";
  if (/screen/i.test(leaf)) return "ohmail/Screened";
  if (/receipt|invoice|order|billing|paper\s*trail|statement|purchase/i.test(leaf)) return "ohmail/Receipts";
  if (/feed|news|newsletter|bulk|promo|marketing|updates?|social|notif/i.test(leaf)) return "ohmail/Reads";

  // Unknown user folder → no inferable intent → skip.
  return null;
}

/**
 * Scan every server folder and produce migration observations.
 *
 * Deterministic and side-effect-free beyond the two read calls on `scanner`.
 * Folders are visited in a stable order with **INBOX first**, so a sender that
 * appears in both the Imbox and another folder is recorded as approved (→INBOX):
 * the first mapping for a given sender wins. Observations are deduped by
 * `(kind, senderOrDomain)`.
 */
export async function scanFoldersForMigration(
  scanner: FolderScanner,
  opts: ScanOptions = {},
): Promise<MigrationObservation[]> {
  const mapFolder = opts.mapFolder ?? defaultFolderMapper;
  const sampleLimit = opts.sampleLimit ?? 50;
  const kind = opts.kind ?? "sender";

  const folders = await scanner.listFolders();
  // Stable order, INBOX first (approved senders take precedence on conflict).
  const ordered = [...folders].sort((a, b) => {
    const ai = a.toUpperCase() === "INBOX" ? 0 : 1;
    const bi = b.toUpperCase() === "INBOX" ? 0 : 1;
    return ai - bi || (a < b ? -1 : a > b ? 1 : 0);
  });

  const seen = new Map<string, MigrationObservation>();   // key: `${kind}:${senderOrDomain}`
  for (const folder of ordered) {
    const destination = mapFolder(folder);
    if (destination == null) continue;                     // skipped folder
    const senders = await scanner.sampleSenders(folder, sampleLimit);
    for (const raw of senders) {
      const address = raw.trim().toLowerCase();
      if (!address || !address.includes("@")) continue;
      const value = kind === "domain" ? domainOf(address) : address;
      if (!value) continue;
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;                         // first mapping wins (INBOX-first)
      seen.set(key, { senderOrDomain: value, kind, destination });
    }
  }
  return [...seen.values()];
}
