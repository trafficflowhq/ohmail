import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The words a person reads, by key. A journey never writes a sentence: it names a key, and the
 * catalogue the web app ships answers in the language the run asked for (`TF_JOURNEYS_LANG`).
 */
export type Language = "en" | "de";
export type CatalogueKey = string;

export const LANGUAGES: readonly Language[] = ["en", "de"];

export function language(env: NodeJS.ProcessEnv = process.env): Language {
  const raw = (env.TF_JOURNEYS_LANG ?? "en").trim();
  if (raw === "en" || raw === "de") return raw;
  throw new Error(`TF_JOURNEYS_LANG must be "en" or "de", not ${JSON.stringify(raw)}`);
}

type Tree = { [key: string]: string | Tree };
const loaded = new Map<Language, Tree>();

export function catalogue(lang: Language): Tree {
  let tree = loaded.get(lang);
  if (!tree) {
    const file = fileURLToPath(new URL(`../../../apps/webapp/messages/${lang}.json`, import.meta.url));
    tree = JSON.parse(readFileSync(file, "utf8")) as Tree;
    loaded.set(lang, tree);
  }
  return tree;
}

/** The catalogue's own text for `key` (a dotted path), or null when the catalogue has none. */
export function raw(key: CatalogueKey, lang: Language): string | null {
  let at: string | Tree | undefined = catalogue(lang);
  for (const part of key.split(".")) {
    if (typeof at !== "object" || at === null) return null;
    at = at[part];
  }
  return typeof at === "string" ? at : null;
}

/** The end of the argument that opens at `open` (a `{`), braces balanced. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces in ${JSON.stringify(text)}`);
}

/** The branches of a plural argument: `one {..} other {..}` and `=0 {..}`. */
function branches(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf("{", i);
    if (open < 0) break;
    const end = closing(body, open);
    out.set(body.slice(i, open).trim(), body.slice(open + 1, end));
    i = end + 1;
  }
  return out;
}

/**
 * The catalogue's message with its arguments filled: `{name}`, and `{n, plural, one {..} other {..}}`
 * with `#`. Markup tags are dropped, as a screen reader drops them. A message that needs an argument
 * the caller did not give throws: a name with a hole in it finds nothing.
 */
export function format(text: string, args: Record<string, string | number> = {}, lang: Language = "en"): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const end = closing(text, open);
    const inner = text.slice(open + 1, end);
    const [name, kind, ...rest] = inner.split(",");
    const arg = name!.trim();
    const value = args[arg];
    if (value === undefined) throw new Error(`the message ${JSON.stringify(text)} needs {${arg}}`);
    if (kind === undefined) out += String(value);
    else if (kind.trim() === "plural") {
      const options = branches(rest.join(","));
      const n = Number(value);
      const rule = new Intl.PluralRules(lang).select(n);
      const chosen = options.get(`=${n}`) ?? options.get(rule) ?? options.get("other");
      if (chosen === undefined) throw new Error(`no plural branch for ${n} in ${JSON.stringify(text)}`);
      out += format(chosen.replaceAll("#", String(n)), args, lang);
    } else throw new Error(`the argument kind ${JSON.stringify(kind.trim())} is not read here: ${JSON.stringify(text)}`);
    i = end + 1;
  }
  return out.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

/** What the catalogue says for `key` in `lang`, arguments filled. Throws on a key it does not hold. */
export function say(key: CatalogueKey, args: Record<string, string | number> = {}, lang: Language = language()): string {
  const text = raw(key, lang);
  if (text === null) throw new Error(`the ${lang} catalogue has no key ${JSON.stringify(key)}`);
  return format(text, args, lang);
}
