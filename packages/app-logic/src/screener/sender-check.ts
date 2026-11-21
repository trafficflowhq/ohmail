import type { EngineMessage } from "@ohmail/wire";
import { authScreens } from "@trafficflow/core/sender-headers";

/**
 * THE IDENTITY FACT AS THE APP RENDERS IT — off the mirror's copy of `MessageDTO.senderCheck`,
 * never a dictionary of the client's own. One sentence and one chip face, keyed under the
 * Screener's catalogue and read outside any AI advice: a marked message says so whether or not a
 * suggestion was ever bought for its sender. An `unverified` fact is the brand's own address whose
 * provider did not confirm the sender: it has its sentence and no chip. A `failed` fact is a letter
 * its provider failed (a verdict the gate screens on): its sentence outranks any claim, and no chip.
 */
export type SenderCheckFact = {
  brand: string;
  domainShared: boolean;
  /** The address's own domain, which the sentence names. */
  domain: string;
} & ({ reason: "impersonation" | "unverified" } | { reason: "failed"; address: string });

type Checked = Pick<EngineMessage, "senderCheck" | "from" | "authVerdict">;

/** The claim the letter's name makes, read off the wire alone: the chip's fact. */
export function claimFact(m: Checked): SenderCheckFact | null {
  const c = m.senderCheck;
  if (!c || (c.reason !== "impersonation" && c.reason !== "unverified") || !c.brand) return null;
  const at = m.from.address.lastIndexOf("@");
  return {
    reason: c.reason,
    brand: c.brand,
    domainShared: c.domainShared === true,
    domain: at < 0 ? "" : m.from.address.slice(at + 1).toLowerCase(),
  };
}

export function senderCheckFact(m: Checked): SenderCheckFact | null {
  if (!authScreens(m.authVerdict)) return claimFact(m);
  const at = m.from.address.lastIndexOf("@");
  return {
    reason: "failed",
    brand: "",
    domainShared: false,
    domain: at < 0 ? "" : m.from.address.slice(at + 1).toLowerCase(),
    address: m.from.address,
  };
}

/** The fact a sender's letters say together: a claim on any of them outranks an unconfirmed line. A
 *  failed check is a letter's own, said where that letter is (`line`). */
export function senderCheckAmong(ms: readonly Checked[]): SenderCheckFact | null {
  const facts = ms.map(claimFact).filter((f): f is SenderCheckFact => f !== null);
  return facts.find((f) => f.reason === "impersonation") ?? facts[0] ?? null;
}

type Words = (key: string, values?: Record<string, string>) => string;

/** The sentence a fact stands for: the shared-provider form names the domain anyone can register at. */
export function senderCheckSentence(
  t: Words,
  f: SenderCheckFact | { reason: "failed"; address?: string },
): string {
  if (f.reason === "failed") return t("senderCheck.failed", { address: f.address ?? "" });
  if (f.reason === "unverified") return t("senderCheck.unverified", { brand: f.brand });
  return f.domainShared
    ? t("senderCheck.impersonationShared", { brand: f.brand, domain: f.domain })
    : t("senderCheck.impersonation", { brand: f.brand, domain: f.domain });
}
