/**
 * THE WORD THIS INSTALL USES FOR THE MACHINE IT RUNS ON — "Mac", "PC" or "computer".
 *
 * The door chooser and the Desktop settings pane both talk about "this Mac", and for two of the
 * three platforms this app ships to that sentence was simply wrong: the Linux AppImage and the
 * Windows installer rendered a stranger's vocabulary. The word is a fact about the running
 * binary, not a preference, so it is resolved the same way the engine resolves the device kind
 * it declares to the hosted side (`desktopDeviceKind(process.platform)` in
 * `apps/sidecar/src/cloud-signin.ts`): from what the build actually is.
 *
 * HOW THE WINDOW LEARNS IT. The engine's declaration is not reachable here — the door chooser is
 * a fresh install's first paint, before any door is chosen and before any engine process exists
 * to ask. What IS available is the build itself: the UI bundle is produced by `tauri build` on
 * the platform it ships to (macos-15 / windows-latest / ubuntu-latest in the release workflow),
 * so `process.platform` at bundle time IS the platform of every machine that will ever run this
 * artifact. `vite.config.ts` folds it into `__OHMAIL_PLATFORM__` the way it already folds the
 * version, and this module owns the one mapping from that fact to a word.
 *
 * Deliberately NOT the webview's `navigator.userAgent`: WebKitGTK is free to present a Mac UA
 * for site compatibility, which would keep the Linux build saying "Mac" while looking fixed.
 *
 * An unrecognized platform (a BSD somebody compiled for) gets "computer" — the honest generic,
 * the same silence-over-guess rule `desktopDeviceKind` applies when the vocabulary has no word.
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
