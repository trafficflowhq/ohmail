/**
 * A MAIL SERVER ON THIS COMPUTER TRUSTED BY ITS OWN CERTIFICATE, not in this build — substituted for
 * `../host-pin-probe.js`. The desktop's local door reads such a server's certificate with one
 * unverified handshake (`node:tls`); a phone trusts no certificate of its own and its engine never
 * passes the option, so the module carries none of that code and reads nothing.
 */
export async function readLoopbackMailCertificate(): Promise<null> {
  return null;
}
