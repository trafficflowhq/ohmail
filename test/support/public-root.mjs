import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WHERE A PUBLISHED FILE SITS IN THIS CHECKOUT.
 *
 * The tests that read what the public repository ships — its workflows and their scripts, the README,
 * the CHANGELOG, docs/, Resources/ — were written where those files lived under public/ohmail/, the
 * workflows under public/ohmail/github/. In this repository they sit at the root and the workflows
 * under .github/. One rule, so no test guesses on its own: public/ohmail/<x> when that directory
 * exists, else <x> at the root, a leading github/ read as .github/.
 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TEMPLATE = "public/ohmail";

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

/** The path of a published file relative to `root`, written as it is published (`github/workflows/ci.yml`). */
export function publicRel(rel, root = ROOT) {
  const clean = String(rel).replace(/^\/+/, "");
  if (isDir(join(root, TEMPLATE))) return `${TEMPLATE}/${clean}`;
  return clean.replace(/^github(?=\/|$)/, ".github");
}

/** The absolute path of a published file. */
export function publicPath(rel, root = ROOT) {
  return join(root, publicRel(rel, root));
}

/**
 * THE ROOTS A CENSUS WALKS ARE THE ONES THIS CHECKOUT HOLDS. The operator console (apps/admin) is not
 * part of this repository, so a census naming it walks what is here and skips that root. Any other
 * root that is missing is refused by name: a census that quietly walked nothing would pass for ever.
 */
export const PRIVATE_ROOTS = ["apps/admin"];

export function presentRoots(roots, root = ROOT) {
  const out = [];
  for (const r of roots) {
    if (existsSync(join(root, r))) out.push(r);
    else if (!PRIVATE_ROOTS.some((p) => r === p || r.startsWith(`${p}/`))) throw new Error(`a census root is missing: ${r}`);
  }
  return out;
}
