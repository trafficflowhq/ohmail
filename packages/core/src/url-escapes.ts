/**
 * PERCENT-ESCAPES OF UNRESERVED CHARACTERS, DECODED. RFC 3986 §2.3 and §6.2.2.2 make `%6F` and `o`
 * the same url, so a rule that reads a url's words reads it with these decoded, or a tracking pixel
 * spelled `/%6fpen` is not `/open`. ONLY the unreserved octets — ALPHA, DIGIT, `-._~`, hex in either
 * case: a decoded `%2F`, `%3F` or `%23` would change what the url says, and the string a rule
 * tests must be the one that is fetched. Import-free, because three graphs read it.
 */
export function decodeUnreservedEscapes(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (escape: string, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : escape;
  });
}
