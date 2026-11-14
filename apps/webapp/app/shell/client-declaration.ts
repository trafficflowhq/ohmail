/**
 * WHO THIS BUILD IS, said on every request (`x-ohmail-client`, `@ohmail/client-engine`'s
 * `client-header.ts`). The shell is shared and cannot know its host, so the host says it once and
 * the web's doors read it: the API client, the refresh and the engine's adapter. Only the web arms
 * it (`session-refresh.ts`, the module every one of those doors loads). The desktop's window and the
 * page a desktop serves name themselves at their own transports, and read an empty declaration here.
 */
import { clientHeaders, type ClientKind } from "@ohmail/client-engine";

let declaration: Readonly<Record<string, string>> = {};

export function declareClient(kind: ClientKind, release: string | null | undefined): void {
  declaration = clientHeaders(kind, release);
}

/** The header pair a door spreads into its own; empty where no host declared one. */
export function clientDeclaration(): Readonly<Record<string, string>> {
  return declaration;
}
