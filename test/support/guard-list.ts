import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

/**
 * THE PRIVACY GUARD'S REAL ENTRIES, READ ONLY WHERE A RUN NAMES THEM. They live in one private file
 * outside every checkout, and a run names it by an absolute path in OHMAIL_GUARD_LIST; nothing else
 * turns PRIVATE MODE on. Every reader of the guard asks here and hands the text to `guardFrom` in
 * `@ohmail/testing`. Unset, the run is in PUBLIC MODE: the readers get the synthetic set and each
 * PRIVATE MODE arm is skipped with that reason in its title. Set, the value must be an absolute path
 * outside this checkout to a readable file with an entry, or every reader refuses by the variable's
 * name, never by its value. In the private repository (the checkout holding the publisher) an unset
 * variable refuses too: PUBLIC MODE is a public checkout's, and that refusal retires with the publisher
 * at the cutover. No reader may print an entry: messages name one by its index.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The variable a run names the private list in. */
export const GUARD_LIST_ENV = "OHMAIL_GUARD_LIST";

export type GuardListReading =
  | { readonly mode: "private"; readonly text: string }
  | { readonly mode: "public"; readonly why: string };

/** The reading of `env`: PUBLIC MODE when the variable is unset, else the list's text, or a refusal by name. */
export function readGuardList(env: Readonly<Record<string, string | undefined>> = process.env, repo: string = REPO): GuardListReading {
  const named = env[GUARD_LIST_ENV];
  if (named === undefined) {
    if (existsSync(path.join(repo, "scripts/publish-desktop.mjs"))) {
      throw new Error(`${GUARD_LIST_ENV} is unset in a checkout that holds scripts/publish-desktop.mjs, the private repository: `
        + "run through the ops kit's private-lists.sh wrapper, which names the list (PUBLIC MODE is a public checkout's)");
    }
    return { mode: "public", why: `${GUARD_LIST_ENV} is unset` };
  }
  const refuse = (why: string): never => {
    throw new Error(`${GUARD_LIST_ENV} ${why}: name the private list by an absolute path outside every checkout, or unset it for PUBLIC MODE`);
  };
  if (!path.isAbsolute(named)) refuse("is not an absolute path");
  let real = "";
  try {
    real = realpathSync(named);
  } catch {
    refuse("names nothing that exists");
  }
  const rel = path.relative(realpathSync(repo), real);
  if (!(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) refuse("names a file inside this checkout");
  let text = "";
  try {
    text = readFileSync(real, "utf8");
  } catch (e) {
    refuse(`names a file that cannot be read (${(e as { code?: string }).code ?? "unreadable"})`);
  }
  if (!text.split("\n").some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))) refuse("names a file with no entry");
  return { mode: "private", text };
}

/** This run's reading, once per reader file: a refusal throws here, so every reader fails at collection. */
export const GUARD_LIST: GuardListReading = readGuardList();

/** True when the run names the private list. */
export const PRIVATE_MODE: boolean = GUARD_LIST.mode === "private";

/** The private list's text in PRIVATE MODE, else `null` (`guardFrom(null)` is the synthetic set). */
export function privateGuardText(): string | null {
  return GUARD_LIST.mode === "private" ? GUARD_LIST.text : null;
}

/** The note a PRIVATE MODE arm's title ends with when PUBLIC MODE skips it. */
export const publicModeNote = (why: string): string => `[skipped: PUBLIC MODE, ${why}]`;

/** A PRIVATE MODE arm: it runs on the private list, and in PUBLIC MODE it is skipped with the reason in its title. */
export function privateModeIt(title: string, fn: () => void): void {
  if (GUARD_LIST.mode === "private") it(title, fn);
  else it.skip(`${title} ${publicModeNote(GUARD_LIST.why)}`, fn);
}

/* The mode at the head of every reader's output, so a run that forgot the list says so in its log. */
console.info(GUARD_LIST.mode === "private"
  ? `[guard] PRIVATE MODE: the readers run on the list ${GUARD_LIST_ENV} names`
  : `[guard] PUBLIC MODE: ${GUARD_LIST.why}, so the readers run on the synthetic set and every PRIVATE MODE arm is skipped`);

/**
 * `text` with every entry of `lists` replaced by `[#i]`, its index (shared first, then corpus-only):
 * longest first, so an entry inside a longer one never leaves a fragment, and case-insensitive. A red
 * that names a file path or a folder runs it through here, because the name can carry an entry.
 */
export function maskEntries(text: string, lists: { readonly shared: readonly string[]; readonly corpusOnly: readonly string[] }): string {
  const entries = [...lists.shared, ...lists.corpusOnly].map((term, i) => ({ term, i }));
  return entries
    .sort((a, b) => b.term.length - a.term.length)
    .reduce((out, { term, i }) => out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), `[#${i}]`), text);
}
