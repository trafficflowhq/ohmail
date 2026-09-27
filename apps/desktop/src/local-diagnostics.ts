/**
 * SETTINGS → ABOUT → DIAGNOSTIC FILE, on the desktop. The window asks the shell for the log's
 * newest lines and the platform's names, builds the file with the one builder the phone shares,
 * and hands the text back for the shell to write beside `engine.log`. Nothing here opens a
 * connection. The install identity is kept in this window's storage, through the durable door, and
 * rotates on the builder's schedule; a refused write means the next file wears a fresh one.
 */
import {
  buildDiagnosticBundle,
  diagnosticInstall,
  renderDiagnosticBundle,
  type DiagnosticMailboxInput,
} from "@trafficflow/core/diagnostics";
import { localStorageDoor, type StorageDoor } from "@ohmail/client-engine/durable";

import { DESKTOP_WINDOW } from "../../webapp/app/shell/store-windows.js";
import { invokeShell } from "./bridge-fetch.js";
import { BUILD_SHA, BUILD_VERSION } from "./build-id.js";

/** Where the install identity is kept between files. */
export const DIAGNOSTIC_INSTALL_KEY = "ohmail.diagnostics.install";

export interface DesktopDiagnosticDeps {
  facts: () => Promise<unknown>;
  save: (text: string) => Promise<unknown>;
  now: () => Date;
  storage: StorageDoor;
  random16: () => Uint8Array;
  app: () => { uptimeMs: number | null; heapUsedBytes: number | null; heapTotalBytes: number | null };
}

/** What the pane knows that the shell does not: the mirror's counts, the mailbox rows, the checks run. */
export interface DesktopDiagnosticState {
  counts: Readonly<Record<string, number>>;
  mailboxes: readonly DiagnosticMailboxInput[];
  /** The session's self-check readings by mailbox id; absent or empty when none was run. */
  selfChecks?: Readonly<Record<string, unknown>>;
}

function storedInstall(storage: StorageDoor): unknown {
  try {
    const raw = storage.get(DIAGNOSTIC_INSTALL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Build the file and have the shell write it. Answers the path the shell wrote, or throws. */
export async function writeDesktopDiagnostics(
  state: DesktopDiagnosticState,
  deps: DesktopDiagnosticDeps = liveDesktopDiagnosticDeps(),
): Promise<string> {
  const now = deps.now();
  const { record, rotated } = diagnosticInstall(storedInstall(deps.storage), now, () => hex(deps.random16()));
  if (rotated) deps.storage.set(DIAGNOSTIC_INSTALL_KEY, JSON.stringify(record));
  const facts = (await deps.facts()) as { os?: unknown; arch?: unknown; lines?: unknown } | null;
  const lines = Array.isArray(facts?.lines) ? facts.lines.filter((l): l is string => typeof l === "string") : [];
  const bundle = buildDiagnosticBundle({
    surface: "desktop",
    now,
    build: { version: BUILD_VERSION, commit: BUILD_SHA || null },
    platform: {
      os: typeof facts?.os === "string" ? facts.os : null,
      arch: typeof facts?.arch === "string" ? facts.arch : null,
    },
    install: record,
    app: deps.app(),
    store: { counts: state.counts, window: DESKTOP_WINDOW },
    mailboxes: state.mailboxes,
    ...(state.selfChecks ? { selfChecks: state.selfChecks } : {}),
    log: lines,
  });
  const path = await deps.save(renderDiagnosticBundle(bundle));
  if (typeof path !== "string" || path === "") throw new Error("the shell named no file");
  return path;
}

/** The real doors: the shell's two commands, this window's storage, clock and memory reading. */
export function liveDesktopDiagnosticDeps(): DesktopDiagnosticDeps {
  return {
    facts: () => invokeShell("diagnostic_facts"),
    save: (text) => invokeShell("diagnostic_save", { text }),
    now: () => new Date(),
    storage: localStorageDoor("diagnostics.install"),
    random16: () => globalThis.crypto.getRandomValues(new Uint8Array(16)),
    app: () => {
      const memory = (globalThis.performance as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } } | undefined)?.memory;
      return {
        uptimeMs: typeof globalThis.performance?.now === "function" ? Math.round(globalThis.performance.now()) : null,
        heapUsedBytes: memory?.usedJSHeapSize ?? null,
        heapTotalBytes: memory?.totalJSHeapSize ?? null,
      };
    },
  };
}
