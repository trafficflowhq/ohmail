/**
 * Declarations for the phone's alias table, so the suite that reads it can be typechecked.
 * `aliases.js` is JavaScript on purpose: its one production reader is the phone-bundle build script,
 * a plain ESM script that runs before any build step, so a `.ts` table would need compiling before
 * the thing that compiles it. The cost was paid by the TESTS: the substitution suite imports the
 * table, and with no declarations every value was `unknown` behind `TS7016` — fourteen errors from
 * one missing file, so the test was EXCLUDED from `tsconfig.tests.json`, the state this file ends.
 * `SCHEMA_TWIN` is `{ from, to }` and NOT a record like its neighbours, because the substitution is
 * anchored to one specifier and a record would invite a second entry the bundler cannot express. Both the named-export surface and the default object are declared.
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
