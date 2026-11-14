import type { ReactNode } from "react";
import type { Text } from "../../text/index.js";
import type { GatedRefusal } from "../gated.js";
import type { StorageWord } from "../contract.js";
import type { StorageFigures, StoragePlanLine } from "./model.js";

/**
 * A sentence whose catalogue words carry emphasis (`<b>`), said whole and plain: the kit's note draws words, not
 * emphasis, so the words are the shipped sentence and only the bold waits (FOR THE KIT, in the share's notes).
 */
export function plain(t: Text, key: string, values: Record<string, unknown> = {}): string {
  const said = t.rich(key, {
    ...values,
    b: (chunks: ReactNode) => (Array.isArray(chunks) ? chunks.join("") : chunks),
  });
  return typeof said === "string" ? said : "";
}

/** The room as the limit's reason names it: "your trial room of 5 GB", "your plan's 5 GB", "the 5 GB you keep until …". */
export function roomSaid(t: Text, room: StorageFigures["room"]): string {
  if (room.kind === "held") return t("storageRoomHeld", { limit: room.limit, date: room.until });
  return t(room.kind === "trial" ? "storageRoomTrial" : "storageRoomPlan", { limit: room.limit });
}

/** From 80 percent the share, at the limit "Full"; below, nothing. */
export function tagSaid(t: Text, tag: StorageFigures["tag"]): string | undefined {
  if (tag === null) return undefined;
  return tag.kind === "full" ? t("storageTagFull") : t("storageTagPercent", { percent: tag.percent });
}

/** The plan's sentence in its three forms. */
export function planSaid(t: Text, plan: StoragePlanLine): string {
  switch (plan.kind) {
    case "trial":
      return plain(t, "storagePlanTrial", { limit: plan.limit, cap: plan.cap });
    case "until":
      return plain(t, "storagePlanUntil", { limit: plan.limit, cap: plan.cap, date: plan.date });
    case "keeps":
      return plan.plan === null
        ? plain(t, "storagePlanKeeps", { limit: plan.limit })
        : plain(t, "storagePlanKeepsNamed", {
            plan: t("storagePlanName", { plan: plan.plan }),
            limit: plan.limit,
          });
  }
}

/** The sentences a refused change is said by: the shipped card's own, by the door's word. */
export interface RefusalWords {
  readonly settings: Text;
  readonly accessLock: Text;
}

/**
 * Why the change did not leave. An address not confirmed yet has its own sentence; anything else, a second refusal
 * after the factor among it, is "could not open", as the shipped card says it (never "sign in again" here).
 */
export function refusalSaid(words: RefusalWords, refusal: GatedRefusal<StorageWord>): string {
  if (refusal.word === "said") return refusal.said;
  return refusal.word === "unverified"
    ? words.accessLock("mintUnverified")
    : words.settings("storageChangeFailed");
}
