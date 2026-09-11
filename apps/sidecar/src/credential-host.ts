/**
 * The boot contract — whether a sealed mailbox credential belongs to the world this engine booted
 * into. A credential is not a password in the abstract, it is a password PROVED AGAINST ONE SERVER:
 * `PATCH /mailboxes/:id` stores the pair it proved, so the row's `meta.host` records the host that
 * answered, and when it disagrees with this launch's `config.imap.host` the stored secret is a fact
 * about a different server. A mailbox has TWO servers: `credentialIsForeign` gates the launch,
 * `credentialIsForeignSmtp` gates sending. Its own file with NO imports because two programs must
 * agree and cannot share a package (`apps/desktop`'s published manifest declares no
 * `@trafficflow/*`), so one definition means one mutation reddens BOTH guards.
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
 * Was this credential sealed for a DIFFERENT server than the one the engine is configured for? The
 * one-sided default is the whole care: `false` — usable — whenever the comparison cannot be made.
 * The row records no host (a credential predating the probe would otherwise be refused on every
 * launch, so a working mailbox stops to close a rarer case; it keeps running and loses only this
 * protection it never had) or the engine is configured with no host (nothing to disagree with, and a
 * launch in that state has a larger problem). `true` is returned only on a POSITIVE disagreement —
 * both named a host and they differ — the only case in which withholding a password is certainly
 * right, and the case the defect is made of.
 */
export function credentialIsForeign(meta: unknown, configuredHost: string | undefined | null): boolean {
  return disagrees(sealedHost(meta), configuredHost);
}

/**
 * The OUTGOING half of the same question — a different question, so its own function. `meta.smtpHost`
 * is the submission server the credential was SEALED FOR (typed into the same form as the password),
 * NOT "proved against" — nothing dials SMTP at seal, so this compares an AUTHORIZATION, not a proof.
 * It is still the fact the send path needs: when the configured submission host is no longer the one
 * they named, offering the password hands a secret to a server nobody authorized. Its own FLAT key,
 * not `meta.smtp` (which means OAuth COORDINATES and is merged with jsonb `||`, so naming only a host
 * would erase a stored port). It gates SENDING only, never the launch (a moved outgoing server still
 * receives), and the one-sided default is identical: `false` unless the row says something and differs.
 */
export function credentialIsForeignSmtp(
  meta: unknown, configuredSmtpHost: string | undefined | null,
): boolean {
  return disagrees(sealedSmtpHost(meta), configuredSmtpHost);
}

/**
 * The submission host a stored credential was sealed for — THREE answers, not two, and the third is
 * easy to lose. `null` — THE ROW SAYS NOTHING (key absent or non-string): every credential sealed
 * before the key existed, which the comparison reads as "cannot compare". `""` — THE ROW SAYS NO
 * OUTGOING SERVER is authorized: a door submit naming none writes it deliberately, and it disagrees
 * with every real host (or an install could acquire a server the password was never saved for). A
 * hostname — the ordinary case. The first two are "we do not know" versus "we know it is none", and
 * collapsing them was the defect ({@link normalizeHost} makes both empty-ish). The incoming sibling
 * draws no such line: `meta.host` is what the probe DIALLED, so an empty value there is an absence.
 */
export function sealedSmtpHost(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const host = (meta as { smtpHost?: unknown }).smtpHost;
  if (typeof host !== "string") return null;
  return normalizeHost(host);
}

/**
 * The comparison both arms make, written once so they cannot drift. `sealed` has been through
 * {@link normalizeHost} and is `null` only when the row SAYS NOTHING; `configured` is normalised
 * here. Both "cannot compare" cases resolve to `false` — see the two docblocks above for why that is
 * the only defensible direction for a predicate that decides whether to withhold a working password.
 * A `sealed` of `""` is therefore compared rather than excused, and the plain `!==` is what makes
 * "no outgoing server was authorized" disagree with every real host — deliberate: the two callers
 * differ only in which key they read and whether an empty stored value can mean anything, and this
 * is where that second difference has its effect.
 */
function disagrees(sealed: string | null, configuredHost: string | undefined | null): boolean {
  if (sealed === null) return false;
  if (typeof configuredHost !== "string") return false;
  const configured = normalizeHost(configuredHost);
  if (configured.length === 0) return false;
  return sealed !== configured;
}
