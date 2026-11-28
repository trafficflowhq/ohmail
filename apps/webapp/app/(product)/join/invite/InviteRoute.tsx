"use client";

/**
 * `/join/invite` as the web serves it: the household invite's page over the invite's own ceremony
 * (`use-invite-door.ts`), which holds the link's token; the page never sees it. The ceremony's way on to `/join`
 * is its router's, as it was.
 */
import { InvitePage, type InviteDoor, type InviteField, type InviteState } from "@ohmail/app/doors/invite";
import { WebDoor } from "../../door-device";
import { usePendingDoor } from "../../login/use-pending-door";
import { useInviteDoor, type InviteCeremony } from "./use-invite-door";

function stateOf(c: InviteCeremony): InviteState {
  switch (c.phase) {
    case "reading": return { at: "opening" };
    case "missing": return { at: "missing" };
    case "reopen": return { at: "reopen" };
    case "unconfigured": return { at: "unavailable" };
    case "form": return { at: "form", busy: c.busy, refusal: c.error };
  }
}

export function InviteRoute() {
  const c = useInviteDoor();
  const pending = usePendingDoor(c.pending);
  const set: Record<InviteField, (v: string) => void> = {
    email: c.setEmail, name: c.setDisplayName, password: c.setPassword,
  };
  const door: InviteDoor = {
    state: stateOf(c),
    fields: { email: c.email, name: c.displayName, password: c.password },
    type: (field, value) => set[field](value),
    submit: () => c.submit({ preventDefault() {} }),
    pending,
  };
  return (
    <WebDoor>
      <InvitePage door={door} />
    </WebDoor>
  );
}
