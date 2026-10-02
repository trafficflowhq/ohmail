/** A door's host as a person reads it: no imports, so the bridge and the doors can share it. */

/**
 * WHAT TO CALL THE OTHER COMPUTER ON SCREEN — the URL's hostname, and for a tailnet name its
 * first label. `/hello` is not widened with a machine name (a name volunteered by whatever
 * answered is worth less than the address the person typed), so the label derives from the
 * configured origin: `machine.tailnet.ts.net`'s first label is the machine's tailnet name; an
 * IP literal stays an IP — a truncated address is a wrong address. Two machines with one name
 * on two tailnets read alike, which is why Settings → Desktop carries the full origin beside
 * this and the rail does not. Unparseable or absent is `null`, never a guess or the empty
 * string — every sentence built on this interpolates it, and "Can't reach ." is worse.
 */
export function hostLabelOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const m = /^https?:\/\/([^/?#\s:]+)/i.exec(baseUrl.trim());
  const host = m?.[1]?.toLowerCase();
  if (!host) return null;
  return host.endsWith(".ts.net") ? (host.split(".")[0] ?? host) : host;
}
