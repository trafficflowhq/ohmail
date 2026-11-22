import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import { Avatar } from "@ohmail/ui/base";
import type { EventCardRow } from "@ohmail/ui/calendar";
import type { Text } from "../text/index.js";

export function peopleRows(
  record: CalendarEventRecord,
  own: readonly string[] | null,
  t: Text,
): EventCardRow[] {
  const rows: EventCardRow[] = [];
  const { organizer, invitees } = record;
  if (organizer && own && !own.some((address) => address.toLowerCase() === organizer.address.toLowerCase())) {
    rows.push({ label: t("edit.from"), text: organizer.name || organizer.address });
  }
  if (!invitees.length) return rows;
  const answers = new Map<string, number>();
  for (const person of invitees) answers.set(person.answer, (answers.get(person.answer) ?? 0) + 1);
  const optional = invitees.filter(({ role }) => role === "optional").length;
  const note = [...answers].map(([answer, count]) => `${count} ${t("edit.guestAnswer", { answer })}`);
  if (optional) note.push(`${optional} ${t("edit.optional")}`);
  rows.push({
    label: t("edit.invitees"),
    note: note.join(" · "),
    children: invitees.slice(0, 5).map(({ name, address }) => (
      <span key={address} role="img" aria-label={name || address} title={name || address}>
        <Avatar name={name || address} address={address} size="xs" />
      </span>
    )),
  });
  return rows;
}
