export interface DeleteMember {
  readonly at: number | null;
  readonly range: boolean;
  readonly organizer: string | null;
  readonly guests: readonly { readonly address: string; readonly name: string | null }[];
}

type Scope = { kind: "record" } | { kind: "occurrence" | "following"; at: string };

/** The master changes in every scope. Include the changed days the scope removes or is governed by. */
export function deleteAudienceOf(members: readonly DeleteMember[], scope: Scope) {
  const master = members.find((member) => member.at === null);
  if (!master) return null;
  let selected = members;
  if (scope.kind !== "record") {
    const at = Number(scope.at);
    if (!/^-?\d+$/.test(scope.at) || !Number.isSafeInteger(at)) return null;
    const days = members.filter((member) => member.at !== null);
    const active = days.reduce<DeleteMember | null>(
      (latest, member) =>
        member.range && member.at! <= at && (!latest || member.at! > latest.at!) ? member : latest,
      null,
    );
    const replaced = scope.kind === "occurrence" && days.some((member) => member.at === at && !member.range);
    selected = [
      master,
      ...days.filter(
        (member) =>
          (!replaced && member === active) ||
          (scope.kind === "occurrence" ? member.at === at : member.at! >= at),
      ),
    ];
  }
  const organizers = new Set(selected.flatMap((member) => member.organizer ?? []));
  if (organizers.size > 1) return null;
  const organizer = [...organizers][0] ?? null;
  const guests = new Map<string, string>();
  for (const member of selected) {
    for (const guest of member.guests) {
      if (guest.address !== organizer) guests.set(guest.address, guest.name || guest.address);
    }
  }
  if (guests.size > 0 && organizer === null) return null;
  return { names: [...guests.values()], audience: { organizer, guests: [...guests.keys()].sort() } };
}

export function sameDeleteAudience(
  a: { readonly organizer: string | null; readonly guests: readonly string[] },
  b: { readonly organizer: string | null; readonly guests: readonly string[] },
): boolean {
  const names = [...b.guests].sort();
  return (
    a.organizer === b.organizer &&
    a.guests.length === names.length &&
    [...a.guests].sort().every((name, i) => name === names[i])
  );
}
