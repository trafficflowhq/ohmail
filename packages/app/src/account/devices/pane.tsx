/**
 * SETTINGS › DEVICES, REGISTERED over what a host alone can hand it: its door (pairing a device by a link shown once,
 * what is signed in, Remove, ending the other browser sessions), the second factor's dialog and the picture of a link
 * to scan. The account pane's pattern (`account/account/pane.tsx`, its header's four points), copied.
 *
 * Which body is drawn is the host's ANSWER (`accountBodies(host).devices`): these parts draw the pane alone, so the
 * section is listed only where that is the answer. The card that sends a person to the browser and the host's own
 * pane on a computer that serves are a host's doors of their own, not these parts.
 */
import type { ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import type { HostContract } from "../../host/index.js";
import type { SettingsPane } from "../../settings/contract.js";
import { PANE_FACTS, paneOf } from "../../settings/facts.js";
import { accountBodies } from "../bodies.js";
import type { FactorSlot, QrSlot } from "../contract.js";
import { DevicesPane } from "./DevicesPane.js";
import type { DevicesDoor } from "./model.js";
import { useDevices } from "./use-devices.js";

/** What only a host can hand the Devices section. */
export interface DevicesPaneParts {
  /** The devices' door on this host. The same door at every draw. */
  readonly useDoor: () => DevicesDoor;
  /** Subscribe to changes to the account's pairing counts. */
  readonly useWatch?: () => ((refresh: () => void) => () => void) | undefined;
  /** The second factor's dialog, drawn while an act waits for it. */
  readonly factor: FactorSlot;
  /** The picture of a link to scan. */
  readonly qr: QrSlot;
}

/** Whether these parts can draw this host's answer: the pane, and nothing else. */
const draws = (host: HostContract): boolean => accountBodies(host).devices === "pane";

/** The Devices section over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function devicesPane(parts: DevicesPaneParts): SettingsPane {
  function Drawn(): ReactNode {
    const door = parts.useDoor();
    const watch = parts.useWatch?.();
    return <DevicesPane model={useDevices(door, watch)} factor={parts.factor} qr={parts.qr} />;
  }
  function Body(): ReactNode {
    return draws(useFrame().host) ? <Drawn /> : null;
  }
  return {
    ...paneOf("devices", { Body }),
    listed: (host) => PANE_FACTS.devices.listed(host) && draws(host),
  };
}
