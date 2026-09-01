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
 * A mailbox has TWO servers, and moving either one of them raises the same question. The incoming
 * comparison ({@link credentialIsForeign}) gates the launch; the outgoing one
 * ({@link credentialIsForeignSmtp}) gates sending, and its docblock says why those two scopes are
 * different rather than an oversight. What each side compares against differs too, and honestly:
 * the incoming host was PROVED by a dial, the outgoing host was AUTHORIZED by the person who typed
 * both into one form.
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
  return disagrees(sealedHost(meta), configuredHost);
}

/**
 * The OUTGOING half of the same question — and it is a different question, so it has its own
 * function rather than a flag on the one above.
 *
 * ── WHAT THE ROW RECORDS, SAID EXACTLY ─────────────────────────────────────────────────────────
 *
 * `meta.smtpHost` is the submission server the credential was SEALED FOR: the outgoing host the
 * install was configured for at the moment the password was stored, which on both seal paths is
 * the one the person typed into the same form as the password. It is deliberately NOT called
 * "proved against", because on this transport nothing proved it — the seal dials IMAP and stores
 * what answered; no SMTP login is attempted. So this side of the contract compares an
 * AUTHORIZATION, not a proof, and the sentence a refusal produces has to say that too.
 *
 * That is still exactly the fact the send path needs. A password is offered to a pair of servers,
 * and the person who typed it named both. When the configured submission host is no longer the one
 * they named, offering the password to it hands a secret to a server nobody authorized — whatever
 * the incoming side says.
 *
 * ── WHY IT IS ITS OWN FLAT KEY AND NOT `meta.smtp` ─────────────────────────────────────────────
 *
 * `meta.smtp` already exists and already means something else: the submission COORDINATES an
 * OAuth mailbox dials, which exist because one refresh token covers both transports and there is
 * no separate outgoing credential row to hold them. Three sites read it as coordinates. Two
 * reasons not to reuse it:
 *
 *  · a witness is not a coordinate source. Nothing should ever dial from this value; the running
 *    configuration is what says where to submit, and this only says whether it may.
 *  · the stored blob is merged with jsonb `||`, which replaces a top-level key WHOLESALE. A writer
 *    that named only a host inside `meta.smtp` would erase a stored port and TLS mode. A flat
 *    string cannot do that to anything.
 *
 * ── AND WHY THIS IS NOT THE BOOT'S BUSINESS ────────────────────────────────────────────────────
 *
 * The incoming comparison gates the whole launch, because a credential proved for another server
 * must not be dialled at all. This one gates SENDING ONLY. A mailbox whose outgoing server moved
 * still RECEIVES perfectly, and refusing the launch over it would stop somebody's mail arriving to
 * fix a send they may not be making — the same "do not break a working mailbox" direction the
 * one-sided default below is built on. So the credential state the shell renders stays the boot
 * contract's, and this is consulted where the transport is actually opened.
 *
 * The one-sided default is identical, for identical reasons: `false` unless the row SAYS SOMETHING
 * and the configured host differs from it. A credential sealed before anything recorded a
 * submission host says nothing, and every such install would otherwise lose the ability to send
 * the moment it upgraded.
 *
 * "Says something" includes SAYING NONE — see {@link sealedSmtpHost}'s three answers. A row that
 * records the empty string was saved for a pair with no outgoing server, and offering it to one
 * that appeared afterwards is the same defect by another route.
 */
export function credentialIsForeignSmtp(
  meta: unknown, configuredSmtpHost: string | undefined | null,
): boolean {
  return disagrees(sealedSmtpHost(meta), configuredSmtpHost);
}

/**
 * The submission host a stored credential was sealed for.
 *
 * THREE ANSWERS, NOT TWO, AND THE THIRD IS THE ONE A REVIEW ROUND FOUND MISSING:
 *
 *  · `null` — THE ROW SAYS NOTHING. The key is absent, or holds something that is not a string.
 *    This is the answer for every credential sealed before the key existed, which is why the
 *    comparison must read it as "cannot compare" rather than as "no host authorized".
 *  · `""` — THE ROW SAYS NO OUTGOING SERVER IS AUTHORIZED. A door submit that names none writes
 *    the empty string deliberately, and that is a STATEMENT: this password was saved for a pair
 *    with nothing on the outgoing side. It disagrees with every real host, which is the point —
 *    otherwise an install could acquire a submission server without the password ever being
 *    saved for it and the credential would be offered to it, which is the whole defect this
 *    predicate exists to stop, reached by a different route.
 *  · a hostname — the ordinary case.
 *
 * The difference between the first two is exactly the difference between "we do not know" and "we
 * know it is none", and collapsing them was the defect. It matters because {@link normalizeHost}
 * makes both of them empty-ish strings, so the temptation to fold them is real and silent.
 *
 * NOTE THE INCOMING SIBLING DOES NOT DRAW THIS LINE, and that is not an inconsistency:
 * `meta.host` is written by whatever the probe DIALLED, so an empty value there is a row written
 * by a path that never dialled — an absence, not a statement. Only the outgoing key has a writer
 * that can mean "none".
 */
export function sealedSmtpHost(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const host = (meta as { smtpHost?: unknown }).smtpHost;
  if (typeof host !== "string") return null;
  return normalizeHost(host);
}

/**
 * The comparison both arms make, written once so they cannot drift apart.
 *
 * `sealed` has already been through {@link normalizeHost} and is `null` only when the row SAYS
 * NOTHING; `configured` is normalised here. Both "cannot compare" cases resolve to `false` — see
 * the two docblocks above for why that direction is the only defensible one for a predicate that
 * decides whether to withhold a working password.
 *
 * A `sealed` of `""` is therefore compared rather than excused, and the plain `!==` at the end is
 * what makes "no outgoing server was authorized" disagree with every real host. That is deliberate
 * and it is the whole of the fix a review round asked for: the two callers differ only in which
 * key they read and in whether an empty stored value can mean anything.
 */
function disagrees(sealed: string | null, configuredHost: string | undefined | null): boolean {
  if (sealed === null) return false;
  if (typeof configuredHost !== "string") return false;
  const configured = normalizeHost(configuredHost);
  if (configured.length === 0) return false;
  return sealed !== configured;
}
