/**
 * SETTINGS › STORAGE, REGISTERED over what a host alone can hand it: its door (the access answer's figures, the plan's
 * change and the storage mails' switch) and the second factor's dialog. The account pane's pattern
 * (`account/account/pane.tsx`, its header's four points), copied. Which body is drawn is the host's ANSWER
 * (`accountBodies(host).storage`): `pane` where the build may link out (figures, plans and the change), `facts`
 * elsewhere (what is stored, no figure, no verb); both are drawn over the one door.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import { NONE, type HostContract } from "../../host/index.js";
import type { PaneBodyProps, PaneSheet, SettingsPane } from "../../settings/contract.js";
import { PANE_FACTS, paneOf } from "../../settings/facts.js";
import { accountBodies } from "../bodies.js";
import type { FactorSlot } from "../contract.js";
import type { StorageDoor } from "./model.js";
import { StoragePane } from "./StoragePane.js";
import { useStorage } from "./use-storage.js";
import { useText } from "../../text/index.js";
import { tagSaid } from "./said.js";

/** What only a host can hand the Storage section. */
export interface StoragePaneParts {
  /** The storage door on this host, for the account this frame is mounted for. The same door at every draw. */
  readonly useDoor: () => StorageDoor;
  /** The second factor's dialog, drawn while the plan's change waits for it. */
  readonly factor: FactorSlot;
}

/** The body this host's answer asks for, or null: the section is then not listed. */
function bodyOf(host: HostContract): "pane" | "facts" | null {
  const asked = accountBodies(host).storage;
  return asked === NONE ? null : asked;
}

/** The Storage section over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function storagePane(parts: StoragePaneParts): SettingsPane {
  function useSummary() {
    const { figures: signal } = parts.useDoor();
    const figures = useSyncExternalStore(signal.subscribe, signal.read, signal.read);
    const t = useText("settings");
    if (figures === null) return null;
    return {
      value: tagSaid(t, figures.tag ?? { kind: "percent", percent: figures.percent }),
      detail: t("storageOf", { used: figures.used, limit: figures.limit }),
      hot: figures.tag !== null,
    };
  }
  function Drawn({
    body,
    sheet,
  }: {
    readonly body: "pane" | "facts";
    readonly sheet?: PaneSheet;
  }): ReactNode {
    return (
      <StoragePane model={useStorage(parts.useDoor())} body={body} factor={parts.factor} sheet={sheet} />
    );
  }
  function Body({ sheet }: PaneBodyProps): ReactNode {
    const body = bodyOf(useFrame().host);
    return body === null ? null : <Drawn body={body} sheet={sheet} />;
  }
  return {
    ...paneOf("storage", { Body, useSummary }),
    hasFoot: true,
    listed: (host) => PANE_FACTS.storage.listed(host) && bodyOf(host) !== null,
  };
}
