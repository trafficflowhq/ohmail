/**
 * THE WORD THIS INSTALL USES FOR THE MACHINE IT RUNS ON — "Mac", "PC" or "computer".
 * The word is a fact about the running binary, not a preference: the UI bundle is produced by
 * `tauri build` on the platform it ships to, so `process.platform` at bundle time IS the
 * platform of every machine that will run this artifact; `vite.config.ts` folds it into
 * `__OHMAIL_PLATFORM__` and this module owns the one mapping from that fact to a word.
 * Deliberately NOT the webview's `navigator.userAgent` — WebKitGTK may present a Mac UA for
 * site compatibility. An unrecognized platform gets "computer", the same silence-over-guess
 * rule `desktopDeviceKind` (`apps/sidecar/src/cloud-signin.ts`) applies.
 */
export type MachineWord = "Mac" | "PC" | "computer";

/** The mapping alone, pure so the test can assert every platform from one machine. */
export function machineWordOf(platform: string): MachineWord {
  switch (platform) {
    case "darwin": return "Mac";
    case "win32": return "PC";
    // "linux" and anything the vocabulary has no brand word for. Not a fallback that papers
    // over an error: on Linux "computer" IS the right word — there is no "this Linux".
    default: return "computer";
  }
}

/**
 * The word for THIS build. `typeof` guards the one context where the define does not exist —
 * the test runner imports this module from source, where no bundler folded the constant — and
 * there it answers as an unrecognized platform would: "computer".
 */
export const MACHINE_WORD: MachineWord =
  machineWordOf(typeof __OHMAIL_PLATFORM__ === "string" ? __OHMAIL_PLATFORM__ : "");

/**
 * The platform this artifact was BUILT for, as `process.platform` spells it — or "" where no
 * bundler folded the constant in (the test runner, importing this module from source).
 *
 * Beside {@link MACHINE_WORD} rather than derived from it, because the two answer different
 * questions and the vocabulary deliberately collapses cases the mechanism must not. "computer"
 * is the right word for Linux AND for a platform this app has no word for; a rule about how the
 * app updates itself has to be able to tell those apart.
 */
export const BUILD_PLATFORM: string =
  typeof __OHMAIL_PLATFORM__ === "string" ? __OHMAIL_PLATFORM__ : "";
