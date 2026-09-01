/**
 * ═══ THE BOOT CONTRACT ═════════════════════════════════════════════════════════════════════════
 *
 * Whether a sealed mailbox credential belongs to the world this engine booted into.
 *
 * A credential is not a password in the abstract — it is a password PROVED AGAINST ONE SERVER.
 * `PATCH /mailboxes/:id` dials the merged patch and stores the pair it actually proved, so the
 * credential row's `meta.host` records the host that answered. The engine's `config.imap.host` is
 * the host THIS launch was configured for. When those two disagree, the stored secret is a fact
 * about a different server, and handing it to the adapter authenticates to one server with
 * another's password.
 *
 * ── WHY THIS IS ITS OWN FILE, WITH NO IMPORTS ──────────────────────────────────────────────────
 *
 * Two programs have to agree on this comparison and they cannot share a package. The engine
 * (`apps/sidecar/src/engine.ts`) makes the decision; the desktop shell's guard
 * (`apps/desktop/test/desktop-door-reconfigure.test.tsx`) models a whole install across engine
 * boots and has to model this rule as part of it. `apps/desktop` deliberately declares no
 * `@trafficflow/*` dependency — its manifest is published and licence-audited, and every entry in
 * it is a package a stranger's `npm install` must resolve — so the predicate cannot travel through
 * `packages/core`. It travels as a file instead: no imports, no runtime, importable by relative
 * path from either side, and published to the mirror with both of them.
 *
 * The point of one definition rather than two is that ONE mutation reddens BOTH guards. A model
 * that implemented this rule in its own words could go on passing while the engine's copy was
 * deleted, which is a model that asserts the fix into existence instead of testing it.
 */

/**
 * A hostname reduced to what a comparison may look at: surrounding whitespace and case.
 *
 * NOTHING ELSE IS NORMALISED, and that is the conservative direction. A DNS name is
 * case-insensitive, and a value that arrived from a form field or a JSON column can carry
 * whitespace — so those two differences are noise. Every other difference is treated as a real
 * one: this predicate decides whether to WITHHOLD a working password, and inventing an
 * equivalence (a stripped trailing dot, an IDNA fold, a resolved alias) would silently hand the
 * secret over on a pair somebody deliberately typed differently.
 */
function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The host a stored credential was proved against, or `null` when the row does not say.
 *
 * `null` is a real and common answer, not a defect: a credential sealed before the probe recorded
 * `meta.host` carries no host at all, and so does one written by a path that never dialled.
 */
export function sealedHost(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const host = (meta as { host?: unknown }).host;
  if (typeof host !== "string") return null;
  const normalized = normalizeHost(host);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Was this credential sealed for a DIFFERENT server than the one the engine is configured for?
 *
 * ── THE ONE-SIDED DEFAULT, WHICH IS THE WHOLE OF THE CARE THIS NEEDS ───────────────────────────
 *
 * `false` — usable — whenever the comparison cannot be made:
 *
 *  · the row records no host. An install whose credential predates the probe recording one would
 *    otherwise be refused on every launch, so a mailbox that works today would stop working to
 *    close a case that is rarer than it is. The credential is admitted and the install keeps
 *    running; what it loses is this protection, which it never had.
 *  · the engine is configured with no host. There is nothing to disagree WITH, and a launch in
 *    that state has a larger problem than this one — it is not a state to express by withholding
 *    a password, because the resulting sentence would be about the credential and the fault would
 *    be in the configuration.
 *
 * `true` is therefore only ever returned on a POSITIVE disagreement: both sides named a host, and
 * they are not the same host. That is the only case in which withholding a password is certainly
 * right, and it is the case the defect is made of.
 */
export function credentialIsForeign(meta: unknown, configuredHost: string | undefined | null): boolean {
  const sealed = sealedHost(meta);
  if (sealed === null) return false;
  if (typeof configuredHost !== "string") return false;
  const configured = normalizeHost(configuredHost);
  if (configured.length === 0) return false;
  return sealed !== configured;
}
