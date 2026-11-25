import { useId, useRef, useState } from "react";
import { Avatar, Button, Icon, Overlay, Sentence } from "@ohmail/ui/base";
import { toneStyle } from "@ohmail/ui/calendar";
import { GroupHeading } from "@ohmail/ui/mail";
import type { CalendarAnswer, CalendarInvitee } from "@ohmail/wire";
import type { CalendarEventRecord } from "@ohmail/app-logic/calendar";
import { useText } from "../text/index.js";
import { sentInvitees } from "./edit-draft.js";
import "./event-invitees.css";

const GROUPS = ["accepted", "tentative", "none", "declined"] as const;
const ICONS = { accepted: "check", declined: "x" } as const;

type Group = (typeof GROUPS)[number];
const HUES = { accepted: 150, tentative: 78, declined: 25, none: null } as const;

type Person = Pick<CalendarInvitee, "name" | "address">;

function groupOf(answer: CalendarAnswer): Group {
  return answer === "delegated" ? "none" : answer;
}

function GuestAvatar({ person, answer, compact }: { person: Person; answer: Group; compact?: boolean }) {
  const icon = answer === "accepted" || answer === "declined" ? ICONS[answer] : undefined;
  return (
    <span className="cal-guest-face" aria-hidden="true">
      <Avatar name={person.name || person.address} address={person.address} size={compact ? "xs" : "s"} />
      <span className="cal-guest-mark" data-answer={answer} style={toneStyle(HUES[answer])}>
        {icon && <Icon name={icon} size={16} className="cal-guest-mark-icon" />}
      </span>
    </span>
  );
}

export function EventInvitees({
  guests,
  organizer,
  confirmed,
}: {
  guests: readonly CalendarInvitee[];
  organizer: CalendarEventRecord["organizer"];
  confirmed: CalendarEventRecord | undefined;
}) {
  const t = useText("calendar");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const summary = useId();
  const title = t("edit.invitees");
  const sent = new Map(sentInvitees(confirmed).map(({ address, answer }) => [address.toLowerCase(), answer]));
  const guestRows = guests.map((person) => ({
    person,
    answer: sent.get(person.address.toLowerCase()),
    organizer: false,
  }));
  const compactCounts = GROUPS.flatMap((group) => {
    const count = guestRows.filter(({ answer }) => answer && groupOf(answer) === group).length;
    return count ? [`${count} ${t("edit.guestAnswer", { answer: group })}`] : [];
  });
  const optional = guests.filter(({ role }) => role === "optional").length;
  if (optional) compactCounts.push(`${optional} ${t("edit.optional")}`);
  const people = organizer
    ? [
        { person: organizer, answer: sent.get(organizer.address.toLowerCase()), organizer: true },
        ...guestRows,
      ]
    : guestRows;
  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="oh-control cal-guest-toggle"
        aria-label={title}
        aria-describedby={compactCounts.length ? summary : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="cal-guest-summary">
          <span className="cal-guest-faces">
            {guestRows.slice(0, 5).map(({ person, answer }) => (
              <GuestAvatar key={person.address} person={person} answer={groupOf(answer ?? "none")} compact />
            ))}
          </span>
          {compactCounts.length > 0 && (
            <span id={summary} className="oh-ecard-note">
              {compactCounts.join(" · ")}
            </span>
          )}
        </span>
        <Icon name="down" size={16} className="cal-guest-chevron" />
      </button>
      <Overlay
        open={open}
        onClose={close}
        portal
        inertBackground
        returnFocus={() => trigger.current}
        labelledBy={heading}
        className="cal-guest-dialog"
        scrimMotion="backdrop"
      >
        <header className="cal-guest-head">
          <Sentence id={heading} level={2} end="ink">
            {title}
          </Sentence>
          <Button kind="quiet" size="s" icon="x" label={t("closeEvent")} onPress={close} />
        </header>
        <div className="cal-guest-scroll" tabIndex={0} role="region" aria-labelledby={heading}>
          {[...GROUPS, "pending" as const].map((group) => {
            const members = people.filter(
              ({ answer, organizer }) =>
                (answer || organizer ? groupOf(answer ?? "none") : "pending") === group,
            );
            if (!members.length) return null;
            const label =
              group === "pending" ? t("edit.guestPending") : t("edit.guestAnswer", { answer: group });
            return (
              <section key={group}>
                <GroupHeading count={String(members.length)}>{label}</GroupHeading>
                <ul className="cal-guest-list" role="list">
                  {members.map(({ person, answer, organizer }) => (
                    <li className="cal-guest-row" key={person.address}>
                      <GuestAvatar person={person} answer={group === "pending" ? "none" : group} />
                      <span className="cal-guest-person">
                        <b>{person.name || person.address}</b>
                        {person.name && person.name.toLowerCase() !== person.address.toLowerCase() && (
                          <small className="cal-guest-meta">{person.address}</small>
                        )}
                      </span>
                      <span className="cal-guest-answer">
                        {group === "pending" ? label : t("edit.guestAnswer", { answer: answer ?? "none" })}
                        {organizer && <small className="cal-guest-meta">{t("edit.guestOrganizer")}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </Overlay>
    </>
  );
}
