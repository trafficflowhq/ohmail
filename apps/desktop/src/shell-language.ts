/**
 * THE SHELL'S LANGUAGE, told by the window. The menu bar, the tray and the update dialogs are drawn
 * by the operating system for the Rust side (`src-tauri/src/words.rs`), which cannot read the
 * window's storage; the window tells it the person's language and the shell keeps it for the next
 * launch (`shell_language.rs`). One language per run: the shell answers whether it speaks the
 * language already or will from the next launch.
 *
 * Imports nothing, like `host.ts` and `update.ts`: it is reached from the locale provider, which
 * the boot path runs before anything else.
 */

/** The command the shell registers for this. */
export const SHELL_LANGUAGE_COMMAND = "set_shell_language";

/** The languages the shell speaks; the same two as the window's catalogue. */
export const SHELL_LANGUAGES = ["en", "de"] as const;

export type ShellLanguage = (typeof SHELL_LANGUAGES)[number];

/**
 * What the shell made of it: `spoken` when this run already speaks it, `next-launch` when the
 * next start will, `refused` when there is no shell to tell (the paired page, the preview) or it
 * did not take it.
 */
export type ShellLanguageAnswer = "spoken" | "next-launch" | "refused";

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

function internals(): TauriInternals | null {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const found = host.__TAURI_INTERNALS__;
  return typeof found?.invoke === "function" ? (found as TauriInternals) : null;
}

/** Tell the shell the person's language. Never throws. */
export async function tellShellLanguage(language: ShellLanguage): Promise<ShellLanguageAnswer> {
  const shell = internals();
  if (!shell) return "refused";
  try {
    const spoken = await shell.invoke(SHELL_LANGUAGE_COMMAND, { language });
    if (spoken === true) return "spoken";
    if (spoken === false) return "next-launch";
    return "refused";
  } catch {
    return "refused";
  }
}
