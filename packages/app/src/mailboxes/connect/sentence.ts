import type { Said } from "@ohmail/app-logic/mailboxes/connect/refusal";
import type { Text } from "../../text/index.js";
import type { ConnectNamespace } from "./namespace.js";

/**
 * A REFUSAL'S SENTENCE, AS THE FORM DRAWS IT: the server's own words, or the catalogue's sentence for its key.
 * Where the refusal names a sentence to say instead (`orElse`), that one is said for a key the catalogue does not
 * hold, and for a sentence that comes out as nothing (one that is only a place nothing was handed for): a refusal
 * is never a blank line.
 */
export function sentenceOf(said: Said, text: (namespace: ConnectNamespace) => Text): string {
  if ("server" in said) return said.server;
  const t = text(said.ns);
  if (said.orElse === undefined) return t(said.key, said.values);
  const own = t.has(said.key) ? t(said.key, said.values) : "";
  return own.trim() === "" ? t(said.orElse, said.values) : own;
}
