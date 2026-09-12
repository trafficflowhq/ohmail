/**
 * The body served at `/.well-known/org.flathub.VerifiedApps.txt`, beside the route rather than in
 * it: a Next route file may export only its handlers and the route options, so a helper exported
 * from `route.ts` is a build error — which is how this arrived here.
 *
 * Two states, both reachable and both distinguishable from outside: a token configured and served,
 * or no token and the 404 the path gave before this existed. A placeholder committed at that path
 * would be a third state that looks configured and fails verification.
 */
export function verificationBody(token: string | undefined): string | null {
  const trimmed = token?.trim();
  return trimmed ? `${trimmed}\n` : null;
}
