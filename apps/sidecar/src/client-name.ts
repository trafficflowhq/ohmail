/**
 * WHO IS ASKING: this engine names itself `desktop-engine/<release>` on every request it makes to a
 * server, in `x-ohmail-client` (the client engine's `CLIENT_HEADER`, spelled again here because this
 * process does not link it, and held equal by a test). A request the window made and the proxy
 * relays leaves as the engine's, never the window's: one hop, one client.
 *
 * A leaf with no imports, because three doors read it: a session's requests (`cloud-auth.ts`), the
 * asks before there is one (`cloud-signin.ts`), and the check of a server's address
 * (`cloud-probe.ts`, which the standalone engine mounts too).
 */
export const CLIENT_HEADER = "x-ohmail-client";

const RELEASE_SHAPE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The header's value for this engine: its release where one was baked in, `dev` where none was. */
export function engineClientValue(release: string | undefined): string {
  const stated = release?.trim() ?? "";
  return `desktop-engine/${RELEASE_SHAPE.test(stated) ? stated : "dev"}`;
}

/**
 * A transport that names this engine on every request it carries. A name already on the request is
 * replaced, never doubled. Never put around a storage upload: that goes to another host, which is
 * told nothing.
 */
export function namingFetch(inner: typeof fetch, release: string | undefined): typeof fetch {
  const value = engineClientValue(release);
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(CLIENT_HEADER, value);
    return inner(input, { ...init, headers });
  }) as typeof fetch;
}
