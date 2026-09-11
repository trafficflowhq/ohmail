/**
 * Who this install is to a mailbox — one definition, because two would be the defect it closes.
 * The organizer's identity is a property of the ORGANIZER, never of whichever store it keeps
 * notes in: a cutover to a fresh database must not change who holds a mailbox. Scoped by
 * ENVIRONMENT, so a staging deployment pointed at a production mailbox is a different organizer —
 * two deployments sharing one id expunge each other's claims on renew. It lives here rather than
 * in the worker because the API tier answers the same question: a release asked "is the claim
 * ours" with `organized_by_kind === "cloud"` — a category, not an identity — and cleared rows
 * over claims it could not remove. One id, defined once, resolved the same way by both.
 */

/** The prefix every hosted organizer's id carries, so a human reading `ohmail/_meta` can tell. */
export const CLOUD_INSTALL_ID_PREFIX = "ohmail-cloud";

/** The default `X-Ohmail-Install-Id` for a hosted organizer in the given environment. */
export function cloudInstallId(environment: string): string {
  return `${CLOUD_INSTALL_ID_PREFIX}:${environment}`;
}

/**
 * The id this deployment actually writes, override included.
 *
 * `TF_ORGANIZER_INSTALL_ID` exists for the one case the default cannot serve — a self-hosted Cloud
 * organizing the same mailbox as ours — and BOTH halves have to honour it, or the override moves
 * the worker's identity and leaves the API deciding against the default.
 */
/**
 * The variables read, as an index signature rather than three optional fields.
 *
 * Three optional fields make a WEAK TYPE, and TypeScript refuses `process.env` against one —
 * "no properties in common" — which would push every caller into a cast at exactly the boundary
 * where a cast hides a typo in a variable name.
 */
export type OrganizerInstallEnv = Readonly<Record<string, string | undefined>>;

/**
 * THE ENVIRONMENT, derived here so both halves derive it the same way.
 *
 * The worker read `TF_ENV ?? RAILWAY_ENVIRONMENT_NAME ?? "production"` in its own config and the
 * API tier read nothing at all. Two deployments that disagree about which environment they are in
 * disagree about who they are, and the whole point of this module is that they must not.
 */
export function organizerEnvironment(env: OrganizerInstallEnv): string {
  return headerSafeIdentity(env.TF_ENV ?? env.RAILWAY_ENVIRONMENT_NAME ?? "production") || "production";
}

/**
 * The bytes the mailbox will hold. `formatClaim` writes the id through `headerSafe`, which
 * collapses CR/LF to a space and trims — a claim is an IMAP message, and a newline in a header is
 * header injection. Anything that normalises differently produces an identity that cannot match
 * its own claim, and the comparison is exact; a trim alone was not enough — an override with an
 * interior newline still differed after serialization. This applies the SAME transformation at
 * the source, so config, row and folder carry one value. Deliberately a copy of `headerSafe`'s
 * rule rather than an import (`organizer-lease` imports from here, not the other way round);
 * `organizer-identity-bytes.test.ts` holds the two together.
 */
export function headerSafeIdentity(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/**
 * The id this deployment actually writes, override and environment included.
 *
 * `TF_ORGANIZER_INSTALL_ID` exists for the one case the default cannot serve — a self-hosted Cloud
 * organizing the same mailbox as ours — and BOTH halves have to honour it, or the override moves
 * the worker's identity and leaves the API deciding against the default.
 */
export function resolveCloudInstallId(env: OrganizerInstallEnv): string {
  /* TRIMMED, NOT JUST TESTED FOR BLANKNESS. This tested `override.trim() !== ""` and then returned
     the UNTRIMMED value, while `formatClaim` writes the id through `headerSafe`, which trims. So
     `TF_ORGANIZER_INSTALL_ID=" cloud-a "` put `cloud-a` in the mailbox and kept `" cloud-a "` in
     config: the claim and the identity comparing against it differed by two spaces, and the
     comparison is exact. The mailbox is the master, so the bytes it will hold are the bytes this
     returns — one value, from one place, all the way through. */
  const override = env.TF_ORGANIZER_INSTALL_ID === undefined
    ? undefined
    : headerSafeIdentity(env.TF_ORGANIZER_INSTALL_ID);
  return override !== undefined && override !== ""
    ? override
    : cloudInstallId(organizerEnvironment(env));
}
