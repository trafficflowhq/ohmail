import type { MutationRejectedError } from "@ohmail/client-engine";

/**
 * WHY A READER'S PRESS WAS REFUSED — one reading of `409 organized_elsewhere`'s `{ by, reason }`
 * for every surface, and one sentence per state in `ohbox.whyRefused`. The sentence is the WHY and
 * the way out; each surface puts its own lead in front ("Couldn't revoke that rule.", "Nothing
 * moved."). `starting` is `nobody` while this install's "Organize here" press stands, which only
 * the roster can tell, so the caller passes it.
 */
export type OrganizerRefusal =
  | { kind: "nobody" }
  | { kind: "starting" }
  | { kind: "outdated"; name: string | null }
  | { kind: "elsewhere"; name: string | null };

/** The refusal's organizer facts, or `null` for a refusal that is not about who organizes. */
export function organizerRefusalOf(
  err: Pick<MutationRejectedError, "code" | "details"> | null | undefined,
  opts: { starting?: boolean } = {},
): OrganizerRefusal | null {
  if (err?.code !== "organized_elsewhere") return null;
  const d = (err.details ?? null) as { reason?: unknown; by?: { name?: unknown } | null } | null;
  const raw = d?.by?.name;
  const name = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  if (d?.reason === "no_organizer") return opts.starting === true ? { kind: "starting" } : { kind: "nobody" };
  if (d?.reason === "organizer_outdated") return { kind: "outdated", name };
  return { kind: "elsewhere", name };
}

/** `t` is `useTranslations("ohbox")`. `null` in, `null` out, so a caller can chain the reading. */
export function organizerRefusalSentence(
  r: OrganizerRefusal | null,
  t: (key: string, values?: Record<string, string>) => string,
): string | null {
  if (r === null) return null;
  if (r.kind === "nobody" || r.kind === "starting") return t(`whyRefused.${r.kind}`);
  const k = r.kind === "outdated" ? "outdated" : "elsewhere";
  return r.name ? t(`whyRefused.${k}`, { name: r.name }) : t(`whyRefused.${k}Unknown`);
}
