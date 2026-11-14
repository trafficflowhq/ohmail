import { PHONE_DIAGNOSTIC_ENTITIES, PHONE_DIAGNOSTIC_FILE_NAME, writePhoneDiagnostics } from "../engine/diagnostics";
import { nativePhoneDiagnosticDeps, shareDiagnosticFile } from "../engine/diagnostics-native";
import type { PhoneMailbox } from "../net/mailboxes";
import { createPhoneDiagnosticsDoor } from "./phone-diagnostics";

const ROSTER_WAIT_MS = 2_000;

/** The local file remains available while the paired server cannot supply its roster. */
async function diagnosticRoster(
  readRoster: (signal: AbortSignal) => Promise<PhoneMailbox[] | null>, signal: AbortSignal,
) {
  if (signal.aborted) return null;

  const read = new AbortController();
  const abort = () => read.abort();
  signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const unavailable = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        read.abort();
        resolve(null);
      }, ROSTER_WAIT_MS);
    });
    return await Promise.race([
      readRoster(read.signal),
      unavailable,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function phoneDiagnosticsOf(
  live: () => boolean, readRoster: (signal: AbortSignal) => Promise<PhoneMailbox[] | null>,
) {
  return createPhoneDiagnosticsDoor({
    live,
    fileName: PHONE_DIAGNOSTIC_FILE_NAME,
    share: shareDiagnosticFile,
    write: async (measurements, allowed, signal) => {
      if (measurements.length !== PHONE_DIAGNOSTIC_ENTITIES.length) return null;
      const mailboxes = (await diagnosticRoster(readRoster, signal)) ?? [];
      if (!allowed()) return null;
      const counts = Object.fromEntries(PHONE_DIAGNOSTIC_ENTITIES.map((type, index) => [type, measurements[index]!]));
      const deps = nativePhoneDiagnosticDeps();
      return writePhoneDiagnostics(
        { counts, mailboxes },
        { ...deps, write: (text) => allowed() ? deps.write(text) : Promise.resolve("") },
      );
    },
  });
}
