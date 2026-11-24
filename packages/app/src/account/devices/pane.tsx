/**
 * SETTINGS › DEVICES, REGISTERED over what a host alone can hand it: its door (pairing a device by a link shown once,
 * what is signed in, Remove, ending the other browser sessions), the second factor's dialog and the picture of a link
 * to scan. The account pane's pattern (`account/account/pane.tsx`, its header's four points), copied.
 *
 * Which body is drawn is the host's ANSWER (`accountBodies(host).devices`): these parts draw the pane alone, so the
 * section is listed only where that is the answer. The card that sends a person to the browser and the host's own
 * pane on a computer that serves are a host's doors of their own, not these parts.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import { confirmedAccountForScope, type HostContract } from "../../host/index.js";
import type { PaneBodyProps, PaneSheet, PaneSummary, SettingsPane } from "../../settings/contract.js";
import { PANE_FACTS, paneOf } from "../../settings/facts.js";
import { accountBodies } from "../bodies.js";
import type { FactorSlot, QrSlot } from "../contract.js";
import { useLocale, useText } from "../../text/index.js";
import { DevicesPane, deviceKindText } from "./DevicesPane.js";
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
  readonly End?: () => ReactNode;
}

/** Whether these parts can draw this host's answer: the pane, and nothing else. */
const draws = (host: HostContract): boolean => accountBodies(host).devices === "pane";

/** The Devices section over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function devicesPane(parts: DevicesPaneParts): SettingsPane {
  let snapshot: { owner: string; summary: PaneSummary } | null = null;
  const listeners = new Set<() => void>();
  const read = () => snapshot;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function useSummary() {
    const owner = confirmedAccountForScope(useFrame().host);
    const seen = useSyncExternalStore(subscribe, read, () => null);
    return seen && seen.owner === owner ? seen.summary : null;
  }
  function Drawn({ sheet }: { sheet?: PaneSheet }): ReactNode {
    const door = parts.useDoor();
    const watch = parts.useWatch?.();
    const model = useDevices(door, watch);
    const { host } = useFrame();
    const owner = confirmedAccountForScope(host);
    const t = useText("devices");
    const locale = useLocale();
    const pairing = model.made !== null;
    useEffect(() => {
      if (owner === null || model.list.at !== "read") return;
      const { devices, webGroup } = model.list;
      const count = new Intl.NumberFormat(locale).format(devices.length + (webGroup?.count ?? 0));
      const detail = devices.map((device) => deviceKindText(device.kind, t)).join(" · ") || undefined;
      snapshot = {
        owner,
        summary: { count, detail, hot: pairing, value: pairing ? t("pairing") : undefined },
      };
      for (const listener of listeners) listener();
    }, [locale, model.list, owner, pairing, t]);
    useEffect(
      () => () => {
        if (snapshot?.owner !== owner || !snapshot.summary.hot) return;
        snapshot = { owner: snapshot.owner, summary: { ...snapshot.summary, hot: false, value: undefined } };
        for (const listener of listeners) listener();
      },
      [owner],
    );
    const End = parts.End;
    const place =
      sheet && End
        ? (body: ReactNode, foot?: ReactNode, count?: string) =>
            sheet(
              <>
                {body}
                <End />
              </>,
              foot,
              count,
            )
        : sheet;
    return (
      <>
        <DevicesPane
          model={model}
          factor={parts.factor}
          qr={parts.qr}
          sheet={place}
          phone={host.device.build.surface === "phone"}
        />
        {!sheet && End ? <End /> : null}
      </>
    );
  }
  function Body({ sheet }: PaneBodyProps): ReactNode {
    return draws(useFrame().host) ? <Drawn sheet={sheet} /> : null;
  }
  return {
    ...paneOf("devices", { Body, useSummary }),
    hasFoot: true,
    listed: (host) => PANE_FACTS.devices.listed(host) && draws(host),
  };
}
