import { useMemo, type ReactNode } from "react";
import { useEngineOrNull } from "@ohmail/app-logic/engine";
import { documentHidden } from "@ohmail/app-logic/session/document-hidden";
import { useFrame } from "../../frame/index.js";
import { NONE, panesOf, type None } from "../../host/index.js";
import type { PaneBodyProps, PaneSummary, SettingsPane } from "../../settings/contract.js";
import type { CalendarHalfSlot, FactorSlot } from "../connect/contract.js";
import { MailboxesPane } from "./MailboxesPane.js";

/**
 * The ground's mail state, as the pane reads it where it is mounted: its sentence's key, its re-read and the facts it
 * holds. The seat hands the ground's own `useMailState`; nothing here reads the old shell.
 */
export interface PaneMailState {
  readonly state: { readonly key: string };
  refresh(): unknown;
  readonly mailboxes?: readonly { readonly status: string }[] | null;
}

/** What a shell fills the pane's registration with: each a function, or `none` where it has none. */
export interface MailboxesSlots {
  /** The doors' second-factor dialog. */
  readonly factor: FactorSlot | None;
  /** The calendar's half of a mailbox. */
  readonly calendar: CalendarHalfSlot | None;
  readonly mailState: () => PaneMailState;
}

/**
 * THE MAILBOXES PANE'S REGISTRATION: its body and what the menu says beside its name, from what is in memory alone.
 * Made once by a shell (module scope or a memo), never inline: a registered entry is never a component made in render.
 * The body reads the frame's host, route and commands, and the ground's mail state through its slot.
 */
export function mailboxesPane(slots: MailboxesSlots): Pick<SettingsPane, "Body" | "useSummary"> {
  function Body(_props: PaneBodyProps): ReactNode {
    const { host, route, commands } = useFrame();
    const engine = useEngineOrNull();
    const mail = slots.mailState();
    const { refresh } = mail;
    const importing = mail.state.key === "importing";
    const ground = useMemo(
      () => ({
        importing,
        refresh: () => void refresh(),
        sync: () => void engine?.syncOnce().catch(() => undefined),
      }),
      [engine, importing, refresh],
    );
    const here = route.place === "settings" && route.sub === "mailboxes";
    return (
      <MailboxesPane
        wire={host.wires.mailboxes}
        connect={host.wires.connect}
        capability={host.capabilities.mailboxes}
        service={host.capabilities.service}
        factor={slots.factor}
        calendar={slots.calendar}
        opened={here ? (route.words.mailbox ?? null) : null}
        stage={host.features.stages.firstRun !== NONE}
        subscriptionPane={panesOf(host).billing}
        go={(how) => commands.go({ place: route.place, stage: { id: "firstRun", words: { how } } })}
        ground={ground}
        hidden={documentHidden}
      />
    );
  }
  function useSummary(): PaneSummary | null {
    const facts = slots.mailState().mailboxes;
    if (facts === undefined || facts === null) return null;
    return { count: String(facts.filter((m) => m.status !== "disabled").length) };
  }
  return { Body, useSummary };
}
