/**
 * ONE READER FOR A SESSION COOKIE, in both spellings: the `__Host-` one first (the browser stores
 * it only from this host, `Secure`, `Path=/`, without `Domain=`, so no sibling host can plant it),
 * then the bare one. The server still writes the bare names; every reader takes both a release
 * before any writer changes. Two shapes, one rule: a `Cookie`-header string, and Next's jar.
 */
export const HOST_PREFIX = "__Host-";

/** The value in a `name=value; …` string, or `null` when neither spelling is present. */
export function cookieFromJar(jar: string, name: string): string | null {
  let bare: string | null = null;
  for (const part of jar.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === `${HOST_PREFIX}${name}`) return part.slice(eq + 1).trim();
    if (key === name && bare === null) bare = part.slice(eq + 1).trim();
  }
  return bare;
}

/** The same read over Next's request or header cookie store. */
export function cookieFromStore(store: { get(name: string): { value: string } | undefined }, name: string): string | null {
  return store.get(`${HOST_PREFIX}${name}`)?.value ?? store.get(name)?.value ?? null;
}
