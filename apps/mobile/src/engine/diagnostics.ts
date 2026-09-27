/**
 * SETTINGS → ABOUT → DIAGNOSTIC FILE, on the phone — the pure half. The file is built with the
 * desktop's own builder (through `@ohmail/client-engine`) from the engine sink's newest lines, the
 * mirror's counts and the mailbox rows, and written into the directory the mirror lives in, which
 * is the directory the backup exclusion covers. Nothing here opens a connection; the person shares
 * the file from the share sheet if they choose. `diagnostics-native.ts` supplies the doors.
 */
import {
  DIAGNOSTIC_FILE_NAME,
  MIRROR_ENTITY_TYPES,
  buildDiagnosticBundle,
  diagnosticInstall,
  renderDiagnosticBundle,
  type DiagnosticMailboxInput,
  type EntityReader,
} from "@ohmail/client-engine";

import type { SecureKV } from "../state/servers";
import { MOBILE_WINDOW } from "./boot";

/** The builder's one file name, for the native half: this file is the package's one importer here. */
export const PHONE_DIAGNOSTIC_FILE_NAME = DIAGNOSTIC_FILE_NAME;

/** Where the install identity is kept between files. */
export const PHONE_DIAGNOSTIC_INSTALL_KEY = "ohmail.diagnostics.install";

export interface PhoneDiagnosticDeps {
  kv: SecureKV | undefined;
  now: () => Date;
  random16: () => Uint8Array;
  platform: { os: string; osVersion: string | number | null };
  build: { version: string | null; commit: string | null };
  lines: () => readonly string[];
  /** Write the text beside the mirror and answer the file's location. */
  write: (text: string) => Promise<string>;
}

/** What the screen holds: the mirror to count, the rows the paired door answered, the checks run. */
export interface PhoneDiagnosticState {
  reader: EntityReader | null;
  mailboxes: readonly DiagnosticMailboxInput[];
  /** The session's self-check readings by mailbox id; a reading for a mailbox the roster lacks adds its row. */
  selfChecks?: Readonly<Record<string, unknown>>;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Hermes' own heap reading where the runtime offers one, else nothing. */
function appReading(): { uptimeMs: number | null; heapUsedBytes: number | null; heapTotalBytes: number | null } {
  const hermes = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> } }).HermesInternal;
  let stats: Record<string, unknown> = {};
  try {
    stats = hermes?.getInstrumentedStats?.() ?? {};
  } catch {
    stats = {};
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    uptimeMs: typeof globalThis.performance?.now === "function" ? Math.round(globalThis.performance.now()) : null,
    heapUsedBytes: num(stats.js_allocatedBytes),
    heapTotalBytes: num(stats.js_heapSize),
  };
}

/** Build the file and write it. Answers where it was written, or `null` when nothing was. */
export async function writePhoneDiagnostics(state: PhoneDiagnosticState, deps: PhoneDiagnosticDeps): Promise<string | null> {
  const now = deps.now();
  let stored: unknown = null;
  try {
    const raw = await deps.kv?.get(PHONE_DIAGNOSTIC_INSTALL_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const { record, rotated } = diagnosticInstall(stored, now, () => hex(deps.random16()));
  if (rotated) await deps.kv?.set(PHONE_DIAGNOSTIC_INSTALL_KEY, JSON.stringify(record)).catch(() => {});
  const counts = Object.fromEntries(MIRROR_ENTITY_TYPES.map((t) => [t, state.reader ? state.reader.list(t).length : 0]));
  const bundle = buildDiagnosticBundle({
    surface: "phone",
    now,
    build: deps.build,
    platform: { os: deps.platform.os, arch: null, osVersion: deps.platform.osVersion },
    install: record,
    app: appReading(),
    store: { counts, window: MOBILE_WINDOW },
    mailboxes: [
      ...state.mailboxes,
      ...Object.keys(state.selfChecks ?? {}).filter((id) => !state.mailboxes.some((m) => m.id === id)).map((id) => ({ id })),
    ],
    ...(state.selfChecks ? { selfChecks: state.selfChecks } : {}),
    log: deps.lines(),
  });
  const where = await deps.write(renderDiagnosticBundle(bundle));
  return typeof where === "string" && where !== "" ? where : null;
}

/**
 * The file's location inside `directory` (expo-sqlite's, a bare path on both platforms) as the
 * `file://` URI the file system takes. `name` is the builder's constant.
 */
export function diagnosticFileUri(directory: string, name: string): string {
  const base = directory.startsWith("file://") ? directory : `file://${encodeURI(directory)}`;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
}

/** A `file://` location as a person reads a path. */
export function readablePath(uri: string): string {
  const bare = uri.replace(/^file:\/\//, "");
  try {
    return decodeURI(bare);
  } catch {
    return bare;
  }
}
