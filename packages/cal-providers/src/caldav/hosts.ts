/**
 * Where a password typed for one CalDAV server may travel. A server names other addresses in its
 * answers: where the signed-in person's own resources begin, where the calendars are, where a
 * request should go instead. The standards let each be on another host, and one large provider
 * keeps every account's calendars on a numbered host beside the one a person types. So the typed
 * host is admitted, and so is a host under the same parent name; any other host is not, and gets
 * neither the password nor a request.
 */

/** A host as one spelling: lower case, no dot after it, no brackets around a numbered address. */
function oneSpelling(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** A host that names no parent: a numbered address (with a colon, or ending in a number), or a single label. */
function hasNoParent(host: string): boolean {
  if (host.includes(":")) return true;
  const last = host.slice(host.lastIndexOf(".") + 1);
  return last === "" || (last.charCodeAt(0) >= 48 && last.charCodeAt(0) <= 57);
}

/**
 * The test a host must pass to be sent the credential typed for `typedHost`: it is that host, or it
 * ends with the typed host's parent (the name without its first label) where that parent has two
 * labels or more. `caldav.example.com` admits `p12-caldav.example.com`; `example.org` admits itself.
 *
 * No list of public suffixes is read: a host typed directly under a suffix of two labels
 * (`name.co.uk`) admits that suffix's other names. The server typed is still the one that decides
 * where the password goes, and it holds the password already.
 */
export function credentialHostsFor(typedHost: string): (host: string) => boolean {
  const typed = oneSpelling(typedHost);
  if (typed === "") return () => false;
  const dot = typed.indexOf(".");
  const parent = dot === -1 || hasNoParent(typed) ? "" : typed.slice(dot + 1);
  const siblings = parent.includes(".") ? `.${parent}` : null;
  return (host) => {
    const h = oneSpelling(host);
    return h === typed || (siblings !== null && h.endsWith(siblings) && !hasNoParent(h));
  };
}
