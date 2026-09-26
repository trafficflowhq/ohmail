import { screenerMode } from "../shell/mail-state";
import type { OrganizerRefusal } from "../shell/organizer-refusal";

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

/** `screenerMode`'s aggregation, plus the standing Organize-here press it has no word for. */
export function rulesPostureOf(facts: ReadonlyArray<Row> | null): RulesPosture {
  const role = screenerMode(facts);
  if (role.mode === "organizer") return { mode: "organizer" };
  if (role.mode === "pending") return { mode: "pending", name: role.name };
  const live = (facts ?? []).filter((m) => m.status !== "disabled");
  if (role.reason === "no_organizer" && live.some((m) => Boolean(m.takeoverAuthorizedAt))) {
    return { mode: "starting" };
  }
  return { mode: "blocked", reason: role.reason ?? "no_organizer", name: role.name };
}

/** The refusal a press would meet, before it is pressed — `null` where a press can land. */
export function postureRefusal(p: RulesPosture | undefined): OrganizerRefusal | null {
  if (!p || p.mode === "organizer" || p.mode === "pending") return null;
  if (p.mode === "starting") return { kind: "starting" };
  return p.reason === "no_organizer" ? { kind: "nobody" } : { kind: "outdated", name: p.name };
}
