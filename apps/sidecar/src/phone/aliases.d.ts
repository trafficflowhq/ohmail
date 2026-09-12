/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  DECLARATIONS FOR THE PHONE'S ALIAS TABLE — so the suite that reads it can be typechecked
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `aliases.js` is JavaScript on purpose: its one production reader is the script that builds the
 * phone bundle, a plain ESM script that runs before any build step exists, so a `.ts` table would
 * need compiling before the thing that compiles it.
 *
 * The cost of that was paid by the TESTS. The suite that checks the substitutions imports the
 * table, and with no declarations every value read off it was `unknown` behind a
 * `TS7016` — fourteen errors descending from one missing file. That test was therefore EXCLUDED
 * from `tsconfig.tests.json`, which is the state this file exists to end: a guard about which
 * modules a phone's artifact contains, and it was the one file in the composition suite whose
 * compilation nobody checked.
 *
 * ── WHAT IS DECLARED IS WHAT THE TABLE IS, NOT A CONVENIENT WIDENING ──────────────────────
 *
 * `SCHEMA_TWIN` is `{ from, to }` and NOT a specifier→target record like its four neighbours,
 * because the substitution it describes is anchored to one exact specifier (`./schema-mail.js`)
 * and a record would invite a second entry that the bundler's rule 3 cannot express. Declaring
 * it as a record would compile, and the first person to add a row would find the build silently
 * ignoring it. The shape is the contract.
 *
 * Both an ESM named-export surface AND a default object are declared, because the module has
 * both: the build script imports the default, the census imports the names, and dropping either
 * from here would red a caller that works.
 */

/** A bundler substitution: the specifier a module writes → the file that answers it. */
type SubstitutionTable = Record<string, string>;

/** `apps/sidecar/src/phone` — this directory, absolute. */
export const PHONE: string;
/** The repository root, absolute. */
export const REPO: string;
/** `apps/mobile`, absolute — the app whose bundler resolves the table's package entries. */
export const MOBILE: string;
/** `apps/mobile/src/engine/shims`, absolute. */
export const SHIMS: string;

/**
 * Node builtins, keyed by the BARE name. `bareSpecifiers` answers each in both spellings
 * (`fs` and `node:fs`); the table itself holds one key per module.
 */
export const NODE_MODULES: SubstitutionTable;
/** Non-builtin packages the engine reaches that have no place on a phone. */
export const PACKAGE_ALIASES: SubstitutionTable;
/** The desktop's own modules, keyed by the literal relative specifier written inside `src`. */
export const SIDECAR_SUBSTITUTES: SubstitutionTable;
/** `@trafficflow/api` entry points substituted for a phone-shaped twin. */
export const API_SUBSTITUTES: SubstitutionTable;

/**
 * THE SCHEMA TWIN — one specifier, matched exactly, and that is why this is not a record.
 *
 * `from` is the specifier as written inside `packages/db/src`; `to` is the device twin. The
 * bundler matches `from` whole, so a looser shape here would misdescribe the rule.
 */
export const SCHEMA_TWIN: { from: string; to: string };

/** The two native modules the bundle leaves for the app's own bundler. Exactly two. */
export const EXTERNAL: string[];
/** Absolute paths the bundler binds as globals (`Buffer`, the `process` stand-in). */
export const INJECT: string[];

/** Every bare specifier the table answers, in both spellings, flattened into one record. */
export function bareSpecifiers(): SubstitutionTable;

declare const aliases: {
  PHONE: string;
  REPO: string;
  MOBILE: string;
  SHIMS: string;
  NODE_MODULES: SubstitutionTable;
  PACKAGE_ALIASES: SubstitutionTable;
  SIDECAR_SUBSTITUTES: SubstitutionTable;
  API_SUBSTITUTES: SubstitutionTable;
  SCHEMA_TWIN: { from: string; to: string };
  EXTERNAL: string[];
  INJECT: string[];
  bareSpecifiers: () => SubstitutionTable;
};
export default aliases;
