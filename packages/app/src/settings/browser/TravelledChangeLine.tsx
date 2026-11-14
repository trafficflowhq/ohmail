import type { TravelledNote } from "@ohmail/app-logic/consent/travelled-change";

export function TravelledChangeLine({
  note,
  className = "scn-sg-note",
  t,
}: {
  note: TravelledNote | null;
  className?: string;
  t: (key: string, values?: { name: string }) => string;
}) {
  if (note === null) return null;
  if (note.kind === "asked")
    return (
      <span className={className} role="status">
        {t("screening.asked")}
      </span>
    );
  if (note.kind === "applied")
    return (
      <span className={className} role="status">
        {t("screening.applied")}
      </span>
    );
  const unreadable = note.refusal !== "other";
  const content = note.holder
    ? t(unreadable ? "screening.refusedUnreadable" : "screening.refusedOther", { name: note.holder })
    : t(unreadable ? "screening.refusedUnreadableUnknown" : "screening.refusedOtherUnknown");
  return (
    <span className={className} role="alert">
      {content}
    </span>
  );
}
