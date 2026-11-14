/**
 * SETTINGS › INVITES, REGISTERED over what a host alone can hand it: its door (an invite link made for somebody and
 * shown once, the open invites and their revocation), the second factor's dialog and the picture of a link to scan.
 * The account pane's pattern (`account/account/pane.tsx`, its header's four points), copied. Listed where the host's
 * answer is the pane (`accountBodies(host).invites`).
 */
import type { ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import type { HostContract } from "../../host/index.js";
import type { SettingsPane } from "../../settings/contract.js";
import { PANE_FACTS, paneOf } from "../../settings/facts.js";
import { accountBodies } from "../bodies.js";
import type { FactorSlot, QrSlot } from "../contract.js";
import { InvitesPane } from "./InvitesPane.js";
import type { InvitesDoor } from "./model.js";
import { useInvites } from "./use-invites.js";

/** What only a host can hand the Invites section. */
export interface InvitesPaneParts {
  /** The invites' door on this host. The same door at every draw. */
  readonly useDoor: () => InvitesDoor;
  /** The second factor's dialog, drawn while an act waits for it. */
  readonly factor: FactorSlot;
  /** The picture of a link to scan. */
  readonly qr: QrSlot;
}

const draws = (host: HostContract): boolean => accountBodies(host).invites === "pane";

/** The Invites section over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function invitesPane(parts: InvitesPaneParts): SettingsPane {
  function Drawn(): ReactNode {
    return <InvitesPane model={useInvites(parts.useDoor())} factor={parts.factor} qr={parts.qr} />;
  }
  function Body(): ReactNode {
    return draws(useFrame().host) ? <Drawn /> : null;
  }
  return {
    ...paneOf("invites", { Body }),
    listed: (host) => PANE_FACTS.invites.listed(host) && draws(host),
  };
}
