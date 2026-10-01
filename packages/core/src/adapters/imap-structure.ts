import type { MimeStructure } from "../types.js";

/** A tree deeper or larger than this is refused: mailparser stops at 1 000 nodes, Dovecot nests 100. */
export const MAX_STRUCTURE_DEPTH = 100;
export const MAX_STRUCTURE_NODES = 2000;

class Unusable extends Error {}

/** Own string-valued entries only, keys lowercased; anything else a server sent is dropped. */
function paramsOf(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([k, val]) => [k.toLowerCase(), val]));
}

/**
 * imapflow's parsed BODYSTRUCTURE node → {@link MimeStructure}, keeping what the server said and
 * dropping what imapflow derived: its `part` label is NOT the server's section for an rfc822's
 * encapsulated body (it reuses the wrapper's path), so sections are re-derived from the tree.
 * `undefined` for no structure, a node that is not one, or a tree past the two bounds above —
 * the caller then has no structure, which ingest logs as such.
 */
export function structureOf(node: unknown): MimeStructure | undefined {
  let count = 0;
  const walk = (n: unknown, depth: number): MimeStructure => {
    if (n === null || typeof n !== "object") throw new Unusable();
    count += 1;
    if (count > MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) throw new Unusable();
    const o = n as Record<string, unknown>;
    const kids = Array.isArray(o.childNodes) ? o.childNodes : [];
    return {
      type: typeof o.type === "string" ? o.type.toLowerCase() : "",
      encoding: typeof o.encoding === "string" && o.encoding !== "" ? o.encoding.toLowerCase() : null,
      params: paramsOf(o.parameters),
      id: typeof o.id === "string" ? o.id : null,
      disposition: typeof o.disposition === "string" && o.disposition !== ""
        ? { type: o.disposition.toLowerCase(), params: paramsOf(o.dispositionParameters) }
        : null,
      size: typeof o.size === "number" && Number.isFinite(o.size) ? o.size : null,
      children: kids.map((k) => walk(k, depth + 1)),
    };
  };
  try {
    return node === undefined || node === null ? undefined : walk(node, 0);
  } catch (err) {
    if (err instanceof Unusable) return undefined;
    throw err;
  }
}
