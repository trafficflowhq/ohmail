/**
 * SETTINGS › SECURITY, REGISTERED over what a host alone can hand it: its door (the recovery codes, the authenticator)
 * and the second factor's dialog. The account pane's pattern (`account/account/pane.tsx`, its header's four points),
 * copied. The host hands either the form or the action that opens Security in a browser.
 */
import type { ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import type { HostContract } from "../../host/index.js";
import type { SettingsPane } from "../../settings/contract.js";
import { PANE_FACTS, paneOf } from "../../settings/facts.js";
import { accountBodies } from "../bodies.js";
import type { FactorSlot } from "../contract.js";
import { useWayOut, WayOutPane, type WayOutDoor } from "../way-out/index.js";
import type { SecurityDoor } from "./model.js";
import { SecurityPane } from "./SecurityPane.js";
import { useSecurity } from "./use-security.js";

/** What only a host can hand the Security section. */
interface SecurityFormParts {
  /** The security door on this host. The same door at every draw. */
  readonly useDoor: () => SecurityDoor;
  /** The second factor's dialog, drawn while an act waits for it. */
  readonly factor: FactorSlot;
}

type BrowserParts = { readonly useBrowserDoor: () => WayOutDoor };

export type SecurityPaneParts = SecurityFormParts | BrowserParts;

function InBrowser({ parts }: { readonly parts: BrowserParts }): ReactNode {
  return <WayOutPane model={useWayOut(parts.useBrowserDoor(), "security")} />;
}

/** The Security section over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function securityPane(parts: SecurityPaneParts): SettingsPane {
  const draws = (host: HostContract): boolean =>
    accountBodies(host).security === ("useBrowserDoor" in parts ? "card" : "pane");
  function Form({ form }: { readonly form: SecurityFormParts }): ReactNode {
    return <SecurityPane model={useSecurity(form.useDoor())} factor={form.factor} />;
  }
  function Body(): ReactNode {
    if (!draws(useFrame().host)) return null;
    return "useBrowserDoor" in parts ? <InBrowser parts={parts} /> : <Form form={parts} />;
  }
  return {
    ...paneOf("security", { Body }),
    listed: (host) => PANE_FACTS.security.listed(host) && draws(host),
  };
}
