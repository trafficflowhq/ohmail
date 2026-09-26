import { screenerMode } from "./mail-state";
import type { OrganizerRefusal } from "./organizer-refusal";

/**
 * WHAT A PRESS ON THE RULES PANE CAN DO HERE — the server's `planAccountFanOut`, read from the
 * roster before the press. `organizer`: the edit is written here. `pending`: every live mailbox
 * is held by an install that takes requests, so the edit travels to it. `starting`: nothing
 * organizes yet, but this install's "Organize here" press stands. `blocked`: nothing will carry
 * the edit out, so the server refuses it (409 organized_elsewhere) and the pane says why first.
 */
export type RulesPosture =
  | { mode: "organizer" }
  | { mode: "pending"; name: string | null }
  | { mode: "starting" }
  | { mode: "blocked"; reason: "no_organizer" | "organizer_outdated"; name: string | null };

type Row = NonNullable<Parameters<typeof screenerMode>[0]>[number] & {
  takeoverAuthorizedAt?: string | null;
};

/**
 * `screenerMode`'s aggregation, plus two states it has no word for: the standing Organize-here
 * press, and a reader nothing holds that nobody agreed to organize (setup not finished), which
 * `screenerMode` leaves to the consent screen but where a press is still refused.
 */
export function rulesPostureOf(facts: ReadonlyArray<Row> | null): RulesPosture {
  const role = screenerMode(facts);
  const live = (facts ?? []).filter((m) => m.status !== "disabled");
  const unheld = live.length > 0 && live.every((m) => m.organizerRole === "reader"
    && !(m.organizedBy && (m.organizedBy.kind || m.organizedBy.name)));
  if (role.mode === "organizer" && !unheld) return { mode: "organizer" };
  if (role.mode === "pending") return { mode: "pending", name: role.name };
  const nobody = unheld || role.reason === "no_organizer";
  if (nobody && live.some((m) => Boolean(m.takeoverAuthorizedAt))) return { mode: "starting" };
  return { mode: "blocked", reason: nobody ? "no_organizer" : "organizer_outdated", name: role.name };
}

/** The refusal a press would meet, before it is pressed — `null` where a press can land. */
export function postureRefusal(p: RulesPosture | undefined): OrganizerRefusal | null {
  if (!p || p.mode === "organizer" || p.mode === "pending") return null;
  if (p.mode === "starting") return { kind: "starting" };
  return p.reason === "no_organizer" ? { kind: "nobody" } : { kind: "outdated", name: p.name };
}
