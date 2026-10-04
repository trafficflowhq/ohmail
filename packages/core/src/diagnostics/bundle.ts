/**
 * THE DIAGNOSTIC FILE — one closed shape, one builder, shared by the desktop and the phone.
 *
 * A person presses one Settings action, the file is written beside the engine's log, and they
 * send it by hand; nothing here opens a connection. The shape is a discriminated union of
 * sections, and {@link renderDiagnosticBundle} rebuilds every section from its declared fields
 * by name: a new section without a case, or a new field without its slot, does not compile.
 * It never holds an address, a subject, a folder name, a host name or a sentence.
 */

import { sha256Hex } from "./sha256.js";
import {
  readSelfCheck, type SelfCheckFolderClass, type SelfCheckUnreadable, type SelfCheckVerdict,
} from "./self-check.js";
import {
  crashRecords, labelAdmitted, scrubLogLine, valueFieldAdmitted,
  type DiagnosticCrashRecord, type DiagnosticLogEntry,
} from "./scrub.js";
import {
  DIAGNOSTIC_ARCH, DIAGNOSTIC_BLOCK_REASONS, DIAGNOSTIC_DISABLED_REASONS, DIAGNOSTIC_ENTITY_TYPES,
  DIAGNOSTIC_MAILBOX_ERROR_CODES, DIAGNOSTIC_OS, memberOr,
  type DiagnosticArch, type DiagnosticBlockReason, type DiagnosticDisabledReason,
  type DiagnosticEntityType, type DiagnosticLeaseOutcome, type DiagnosticMailboxErrorCode,
  type DiagnosticOs, type DiagnosticRole, type DiagnosticSurface, type DiagnosticSyncOutcome,
} from "./vocab.js";

export const DIAGNOSTIC_BUNDLE_KIND = "ohmail-diagnostics";
export const DIAGNOSTIC_BUNDLE_VERSION = 1;
/** The one file the action writes, beside `engine.log`, replaced on every press. */
export const DIAGNOSTIC_FILE_NAME = "ohmail-diagnostics.json";
/** The engine.log lines the file carries, newest last. */
export const DIAGNOSTIC_LOG_LINES = 200;
export const DIAGNOSTIC_MAILBOXES_MAX = 50;
/** How long one install identity lasts before the next file is written under a fresh one. */
export const DIAGNOSTIC_INSTALL_ROTATES_AFTER_DAYS = 30;

export type DiagnosticWindow =
  | { mode: "full" }
  | { mode: "windowed"; days: number; minRows: number; maxRows: number | null };

export interface BuildSection { k: "build"; surface: DiagnosticSurface; version: string | null; commit: string | null }
export interface PlatformSection { k: "platform"; os: DiagnosticOs | null; arch: DiagnosticArch | null; osVersion: string | null }
export interface InstallSection { k: "install"; hash: string; since: string | null; rotatesAfterDays: number }
export interface ProcessSection {
  k: "process";
  appUptimeMs: number | null;
  appHeapUsedBytes: number | null;
  appHeapTotalBytes: number | null;
  engineUptimeMs: number | null;
  engineRssBytes: number | null;
  engineHeapUsedBytes: number | null;
  engineHeapTotalBytes: number | null;
  engineStoreBytes: number | null;
}
export interface StoreSection {
  k: "store";
  counts: Record<DiagnosticEntityType, number>;
  otherTypes: number;
  window: DiagnosticWindow | null;
}
/** One folder of the self-check: its name as a keyed hash, its class and its two counts. */
export interface DiagnosticSelfCheckFolder {
  hash: string;
  k: SelfCheckFolderClass;
  server: number | null;
  mirror: number | null;
  error: SelfCheckUnreadable | null;
}
/** The mailbox's last self-check in this session, or `null` on the section when none was run. */
export interface DiagnosticSelfCheck {
  verdict: SelfCheckVerdict;
  checkedAt: string | null;
  elapsedMs: number | null;
  folders: DiagnosticSelfCheckFolder[];
}
export interface MailboxSection {
  k: "mailbox";
  hash: string;
  sync: DiagnosticSyncOutcome;
  errorCode: DiagnosticMailboxErrorCode | null;
  disabledReason: DiagnosticDisabledReason | null;
  blockReason: DiagnosticBlockReason | null;
  role: DiagnosticRole;
  lease: DiagnosticLeaseOutcome;
  selfCheck: DiagnosticSelfCheck | null;
}
export interface LogSection { k: "log"; lines: DiagnosticLogEntry[]; linesRead: number }
export interface CrashSection { k: "crash"; records: DiagnosticCrashRecord[] }

/** THE CLOSED FIELD SET. A member added here is refused by the renderer until it has a case. */
export type DiagnosticSection =
  | BuildSection | PlatformSection | InstallSection | ProcessSection | StoreSection
  | MailboxSection | LogSection | CrashSection;

export interface DiagnosticBundle {
  kind: typeof DIAGNOSTIC_BUNDLE_KIND;
  v: typeof DIAGNOSTIC_BUNDLE_VERSION;
  writtenAt: string;
  sections: DiagnosticSection[];
}

/**
 * A mailbox row as either surface holds one. Wide on purpose: the desktop's `MailboxFacts` and
 * the phone's `PhoneMailbox` both pass, address and folder names included, and only the fields
 * named below are read — each through a closed set, so their types are `unknown` here.
 */
export interface DiagnosticMailboxInput {
  readonly id: string;
  readonly status?: unknown;
  readonly errorCode?: unknown;
  readonly disabledReason?: unknown;
  readonly syncBlockedReason?: unknown;
  readonly organizerRole?: unknown;
  readonly organizerState?: unknown;
  readonly organizerChecked?: unknown;
  readonly releaseRefusal?: unknown;
  readonly lastSyncAt?: unknown;
}

export interface DiagnosticInstallRecord { id: string; mintedAt: string }

export interface DiagnosticInput {
  surface: DiagnosticSurface;
  now: Date;
  build: { version?: string | null; commit?: string | null };
  platform: { os?: string | null; arch?: string | null; osVersion?: string | number | null };
  install: DiagnosticInstallRecord;
  app?: { uptimeMs?: number | null; heapUsedBytes?: number | null; heapTotalBytes?: number | null };
  store?: {
    counts: Readonly<Record<string, number>>;
    window: { mode: string; days?: number; minRows?: number; maxRows?: number } | null;
  } | null;
  mailboxes?: readonly DiagnosticMailboxInput[];
  /** The self-check readings the surface holds, by mailbox id, as the engine answered them. */
  selfChecks?: Readonly<Record<string, unknown>>;
  /** Raw `engine.log` lines, oldest first. Crash records are read from all of them. */
  log?: readonly string[];
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;
const COMMIT_RE = /^(?:[0-9a-f]{7,40}|dev)$/;
const OS_VERSION_RE = /^\d{1,5}(?:\.\d{1,5}){0,3}$/;
const INSTALL_ID_RE = /^[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const text = (re: RegExp, v: unknown): string | null => (typeof v === "string" && re.test(v) ? v : null);

/** The keyed hash every id in the file wears. The install id is the key and never leaves. */
function keyedHash(installId: string, domain: string, value: string): string {
  return sha256Hex(`ohmail-diagnostics:v1:${domain}:${installId}:${value}`).slice(0, 16);
}

/**
 * The install identity to write under: the stored one while it is younger than the rotation,
 * otherwise a fresh one from `mint` (32 random hex characters, supplied by the surface).
 */
export function diagnosticInstall(
  stored: unknown,
  now: Date,
  mint: () => string,
): { record: DiagnosticInstallRecord; rotated: boolean } {
  const s = stored as Partial<DiagnosticInstallRecord> | null;
  const minted = typeof s?.mintedAt === "string" ? Date.parse(s.mintedAt) : Number.NaN;
  const age = now.getTime() - minted;
  if (typeof s?.id === "string" && INSTALL_ID_RE.test(s.id) && age >= 0 && age < DIAGNOSTIC_INSTALL_ROTATES_AFTER_DAYS * DAY_MS) {
    return { record: { id: s.id, mintedAt: s.mintedAt! }, rotated: false };
  }
  const id = mint();
  if (!INSTALL_ID_RE.test(id)) throw new Error("diagnosticInstall: mint must answer 32 lowercase hex characters");
  return { record: { id, mintedAt: now.toISOString() }, rotated: true };
}

function syncOutcome(m: DiagnosticMailboxInput, block: DiagnosticBlockReason | null): DiagnosticSyncOutcome {
  if (m.status === "disabled") return "disabled";
  if (m.status === "error") return "failed";
  if (m.status !== "connected") return "unknown";
  if (block !== null) return "blocked";
  return typeof m.lastSyncAt === "string" && m.lastSyncAt !== "" ? "synced" : "never_synced";
}

function leaseOutcome(m: DiagnosticMailboxInput): DiagnosticLeaseOutcome {
  if (m.syncBlockedReason === "lease_unreadable") return "unreadable";
  if (m.syncBlockedReason === "clock_off") return "clock_off";
  if (m.syncBlockedReason === "meta_folder_full") return "meta_folder_full";
  if (m.syncBlockedReason === "meta_undeletable") return "meta_undeletable";
  if (m.releaseRefusal === "sibling_lapse") return "sibling_lapse";
  if (m.organizerChecked === false) return "unchecked";
  if (m.organizerState === "held") return "held";
  if (m.organizerState === "stopped") return "stopped";
  return "none";
}

/** A mailbox's reading, folder names hashed under the mailbox; a reading for another id is none. */
function selfCheckOf(
  raw: unknown, mailboxId: string, hash: (domain: string, id: string) => string,
): DiagnosticSelfCheck | null {
  const c = readSelfCheck(raw);
  if (c === null || c.mailboxId !== mailboxId) return null;
  return {
    verdict: c.verdict,
    checkedAt: c.checkedAt,
    elapsedMs: c.elapsedMs,
    folders: c.folders.map((f) => ({
      hash: hash("folder", JSON.stringify([mailboxId, f.folder])),
      k: f.k,
      server: f.k === "unreadable" ? null : f.server,
      mirror: f.k === "unreadable" ? null : f.mirror,
      error: f.k === "unreadable" ? f.error : null,
    })),
  };
}

function windowOf(w: NonNullable<DiagnosticInput["store"]>["window"]): DiagnosticWindow | null {
  if (w === null) return null;
  if (w.mode === "full") return { mode: "full" };
  const days = count(w.days);
  const minRows = count(w.minRows);
  if (w.mode !== "windowed" || days === null || minRows === null) return null;
  return { mode: "windowed", days, minRows, maxRows: count(w.maxRows) };
}

/** The latest `engine_vitals` line's numbers, which are the engine process's own reading. */
function engineVitals(entries: readonly DiagnosticLogEntry[]): Record<string, number | boolean | null> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.shape === "event" && e.event === "engine_vitals") return e.values;
  }
  return {};
}

/** Build the bundle. Pure: the surface gathers the input, this decides what of it may be written. */
export function buildDiagnosticBundle(input: DiagnosticInput): DiagnosticBundle {
  const installId = input.install.id;
  const hash = (domain: string, id: string): string => keyedHash(installId, domain, id);
  const raw = input.log ?? [];
  const entries = raw.map((line) => scrubLogLine(line, hash));
  const vitals = engineVitals(entries);

  const counts = Object.fromEntries(DIAGNOSTIC_ENTITY_TYPES.map((t) => [t, 0])) as Record<DiagnosticEntityType, number>;
  let otherTypes = 0;
  for (const [type, n] of Object.entries(input.store?.counts ?? {})) {
    const c = count(n) ?? 0;
    if ((DIAGNOSTIC_ENTITY_TYPES as readonly string[]).includes(type)) counts[type as DiagnosticEntityType] += c;
    else otherTypes += c;
  }

  const osVersion = typeof input.platform.osVersion === "number" ? String(input.platform.osVersion) : input.platform.osVersion;
  const sections: DiagnosticSection[] = [
    { k: "build", surface: input.surface, version: text(VERSION_RE, input.build.version), commit: text(COMMIT_RE, input.build.commit) },
    {
      k: "platform",
      os: memberOr(DIAGNOSTIC_OS, input.platform.os),
      arch: memberOr(DIAGNOSTIC_ARCH, input.platform.arch),
      osVersion: text(OS_VERSION_RE, osVersion),
    },
    {
      k: "install",
      hash: hash("install", ""),
      since: typeof input.install.mintedAt === "string" ? input.install.mintedAt.slice(0, 10) : null,
      rotatesAfterDays: DIAGNOSTIC_INSTALL_ROTATES_AFTER_DAYS,
    },
    {
      k: "process",
      appUptimeMs: count(input.app?.uptimeMs),
      appHeapUsedBytes: count(input.app?.heapUsedBytes),
      appHeapTotalBytes: count(input.app?.heapTotalBytes),
      engineUptimeMs: count(vitals.uptimeMs),
      engineRssBytes: count(vitals.rss),
      engineHeapUsedBytes: count(vitals.heapUsed),
      engineHeapTotalBytes: count(vitals.heapTotal),
      engineStoreBytes: count(vitals.storeBytes),
    },
    { k: "store", counts, otherTypes, window: input.store ? windowOf(input.store.window) : null },
  ];
  for (const m of (input.mailboxes ?? []).slice(0, DIAGNOSTIC_MAILBOXES_MAX)) {
    const blockReason = memberOr(DIAGNOSTIC_BLOCK_REASONS, m.syncBlockedReason);
    const role: DiagnosticRole = m.organizerRole === "organizer" ? "organizer" : m.organizerRole === "reader" ? "reader" : "unknown";
    sections.push({
      k: "mailbox",
      hash: hash("mailbox", String(m.id)),
      sync: syncOutcome(m, blockReason),
      errorCode: memberOr(DIAGNOSTIC_MAILBOX_ERROR_CODES, m.errorCode),
      disabledReason: memberOr(DIAGNOSTIC_DISABLED_REASONS, m.disabledReason),
      blockReason,
      role,
      lease: leaseOutcome(m),
      selfCheck: selfCheckOf(input.selfChecks?.[String(m.id)], String(m.id), hash),
    });
  }
  sections.push({ k: "log", lines: entries.slice(-DIAGNOSTIC_LOG_LINES), linesRead: raw.length });
  sections.push({ k: "crash", records: crashRecords(raw, entries) });
  return { kind: DIAGNOSTIC_BUNDLE_KIND, v: DIAGNOSTIC_BUNDLE_VERSION, writtenAt: input.now.toISOString(), sections };
}

function unreachable(section: never): never {
  throw new Error(`renderDiagnosticBundle: no case for ${JSON.stringify((section as { k?: unknown }).k)}`);
}

function entryOut(e: DiagnosticLogEntry): DiagnosticLogEntry {
  if (e.shape === "withheld") return { shape: "withheld", kind: e.kind };
  return {
    shape: "event", ts: e.ts, level: e.level, service: e.service, event: e.event,
    errorClass: e.errorClass, errorCode: e.errorCode, causeClass: e.causeClass, causeCode: e.causeCode,
    mailbox: e.mailbox, account: e.account,
    values: Object.fromEntries(Object.entries(e.values).filter(([k]) => valueFieldAdmitted(k))),
    labels: Object.fromEntries(Object.entries(e.labels).filter(([k, v]) => labelAdmitted(k, v))),
  };
}

function crashOut(r: DiagnosticCrashRecord): DiagnosticCrashRecord {
  return r.from === "trace"
    ? { from: "trace", errorClass: r.errorClass, frames: [...r.frames] }
    : { from: "event", event: r.event, errorClass: r.errorClass, surface: r.surface, frame: r.frame };
}

function selfCheckOut(c: DiagnosticSelfCheck): DiagnosticSelfCheck {
  return {
    verdict: c.verdict, checkedAt: c.checkedAt, elapsedMs: c.elapsedMs,
    folders: c.folders.map((f) => ({ hash: f.hash, k: f.k, server: f.server, mirror: f.mirror, error: f.error })),
  };
}

/** One section, rebuilt from its own declared fields. The `const` annotations are the census. */
function sectionOut(s: DiagnosticSection): DiagnosticSection {
  switch (s.k) {
    case "build": { const o: BuildSection = { k: s.k, surface: s.surface, version: s.version, commit: s.commit }; return o; }
    case "platform": { const o: PlatformSection = { k: s.k, os: s.os, arch: s.arch, osVersion: s.osVersion }; return o; }
    case "install": { const o: InstallSection = { k: s.k, hash: s.hash, since: s.since, rotatesAfterDays: s.rotatesAfterDays }; return o; }
    case "process": {
      const o: ProcessSection = {
        k: s.k, appUptimeMs: s.appUptimeMs, appHeapUsedBytes: s.appHeapUsedBytes, appHeapTotalBytes: s.appHeapTotalBytes,
        engineUptimeMs: s.engineUptimeMs, engineRssBytes: s.engineRssBytes, engineHeapUsedBytes: s.engineHeapUsedBytes,
        engineHeapTotalBytes: s.engineHeapTotalBytes, engineStoreBytes: s.engineStoreBytes,
      };
      return o;
    }
    case "store": { const o: StoreSection = { k: s.k, counts: { ...s.counts }, otherTypes: s.otherTypes, window: s.window === null ? null : { ...s.window } }; return o; }
    case "mailbox": {
      const o: MailboxSection = {
        k: s.k, hash: s.hash, sync: s.sync, errorCode: s.errorCode, disabledReason: s.disabledReason,
        blockReason: s.blockReason, role: s.role, lease: s.lease,
        selfCheck: s.selfCheck === null ? null : selfCheckOut(s.selfCheck),
      };
      return o;
    }
    case "log": { const o: LogSection = { k: s.k, lines: s.lines.map(entryOut), linesRead: s.linesRead }; return o; }
    case "crash": { const o: CrashSection = { k: s.k, records: s.records.map(crashOut) }; return o; }
    default: return unreachable(s);
  }
}

/** The file's text. Only what {@link sectionOut} rebuilt reaches it. */
export function renderDiagnosticBundle(bundle: DiagnosticBundle): string {
  const out: DiagnosticBundle = {
    kind: DIAGNOSTIC_BUNDLE_KIND,
    v: DIAGNOSTIC_BUNDLE_VERSION,
    writtenAt: bundle.writtenAt,
    sections: bundle.sections.map(sectionOut),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
