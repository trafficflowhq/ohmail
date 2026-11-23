import { confirmedAccountForScope } from "../../host/session.js";
import { useMemo, type ComponentType, type ReactNode } from "react";
import { statusKey } from "@ohmail/app-logic/mailboxes/pane/rows";
import { useEngine } from "@ohmail/app-logic/engine";
import { documentHidden } from "@ohmail/app-logic/session/document-hidden";
import { useSetupPort } from "../../calsetup/use-setup-port.js";
import { useFrame } from "../../frame/index.js";
import { NONE, panesOf, type None } from "../../host/index.js";
import type { PaneBodyProps, PaneSummary, SettingsPane } from "../../settings/contract.js";
import { useLocale, useText } from "../../text/index.js";
import type { CalendarHalfSlot, FactorSlot } from "../connect/contract.js";
import { MailboxesPane } from "./MailboxesPane.js";

/**
 * The ground's mail state, as the pane reads it where it is mounted: its sentence's key, its re-read and the facts it
 * holds. The seat hands the ground's own `useMailState`; nothing here reads the old shell.
 */
export interface PaneMailState {
  readonly state: { readonly key: string };
  refresh(): unknown;
  readonly rosterFailed?: boolean;
  readonly mailboxes?:
    | readonly {
        readonly status: string;
        readonly lastSyncAt?: string | null;
        readonly displayName?: string | null;
        readonly address?: string;
        readonly syncBlockedReason?: string | null;
      }[]
    | null;
}

/** What a shell fills the pane's registration with: each a function, or `none` where it has none. */
export interface MailboxesSlots {
  /** The doors' second-factor dialog. */
  readonly factor: FactorSlot | None;
  /** The calendar's half of a mailbox. */
  readonly calendar: CalendarHalfSlot | None;
  /** Recovery of a saved settings copy, on a host that offers it. */
  readonly savedSettings?: ComponentType;
  /** A device's own status at the head of the mailbox list. */
  readonly head?: ComponentType;
  readonly holdEdit?: boolean;
  readonly useLimit?: () => number | null;
  /** A native roster with device-only operations. It occupies the same registered Settings section. */
  readonly device?: ComponentType<
    PaneBodyProps & {
      goToSetup(how: "add" | "again", mailbox?: string): void;
    }
  >;
  readonly mailState: () => PaneMailState;
}

/** What a host alone can hand the pane: the slots but the ground's, which the mail's panes record names. */
export type MailboxesParts = Omit<MailboxesSlots, "mailState">;

/**
 * THE MAILBOXES PANE'S REGISTRATION: its body and what the menu says beside its name, from what is in memory alone.
 * Made once by a shell (module scope or a memo), never inline: a registered entry is never a component made in render.
 * The body reads the frame's host, route and commands, and the ground's mail state through its slot.
 */
export function mailboxesPane(slots: MailboxesSlots): Pick<SettingsPane, "Body" | "useSummary"> {
  const SavedSettings = slots.savedSettings;
  const Head = slots.head;
  function Body(_props: PaneBodyProps): ReactNode {
    const { host, route, commands } = useFrame();
    const engine = useEngine();
    const setup = useSetupPort();
    const links = setup === NONE ? undefined : setup.linkedMailboxIds;
    const calendarReuse = useMemo(
      () => links && (async (id: string) => (await links()).includes(id)),
      [links],
    );
    const mail = slots.mailState();
    const { refresh } = mail;
    const importing = mail.state.key === "importing";
    const ground = useMemo(
      () => ({
        importing,
        refresh: () => void refresh(),
        sync: () => void engine.syncOnce().catch(() => undefined),
      }),
      [engine, importing, refresh],
    );
    const here = route.place === "settings" && route.sub === "mailboxes";
    return (
      <>
        {Head ? <Head /> : null}
        <MailboxesPane
          wire={host.wires.mailboxes}
          connect={host.wires.connect}
          deviceReady={confirmedAccountForScope(host) !== null}
          capability={host.capabilities.mailboxes}
          service={host.capabilities.service}
          factor={slots.factor}
          holdEdit={
            slots.holdEdit ? (ask) => host.device.address.holdLeave(ask, "#/settings/mailboxes") : undefined
          }
          calendar={slots.calendar}
          calendarReuse={calendarReuse}
          opened={here ? (route.words.mailbox ?? null) : null}
          stage={host.features.stages.firstRun !== NONE}
          subscriptionPane={panesOf(host).billing}
          openPlans={() => commands.go({ place: "settings", sub: "billing" })}
          go={(how) => commands.go({ place: route.place, stage: { id: "firstRun", words: { how } } })}
          ground={ground}
          hidden={documentHidden}
        />
        {SavedSettings ? <SavedSettings /> : null}
      </>
    );
  }
  function useSummary(): PaneSummary | null {
    const t = useText("settingsMenu");
    const failureText = useText("viewError");
    const locale = useLocale();
    const limit = slots.useLimit?.();
    const { mailboxes: facts, rosterFailed } = slots.mailState();
    if (facts == null) return rosterFailed ? { value: failureText("loadFailed") } : null;
    const live = facts.filter((m) => m.status !== "disabled");
    const full = live.some((m) => m.syncBlockedReason === "mailbox_full");
    const statuses = live.map(({ status, lastSyncAt, syncBlockedReason }) =>
      lastSyncAt === undefined || syncBlockedReason ? null : statusKey({ status, lastSyncAt }),
    );
    const connecting = statuses.includes("status_connecting");
    const connected = statuses.length > 0 && statuses.every((status) => status === "status_connected");
    return {
      count:
        limit == null
          ? new Intl.NumberFormat(locale).format(live.length)
          : t("mailboxCount", { count: live.length, limit }),
      value: full
        ? t("mailboxFull")
        : connecting
          ? t("mailboxConnecting")
          : connected
            ? t("mailboxConnected")
            : undefined,
      detail:
        live
          .map((m) => m.displayName || m.address)
          .filter(Boolean)
          .join(" · ") || undefined,
      hot: full,
    };
  }
  const Device = slots.device;
  function DeviceBody(props: PaneBodyProps): ReactNode {
    const { commands, route } = useFrame();
    return (
      Device && (
        <Device
          {...props}
          goToSetup={(how, mailbox) =>
            commands.go({
              place: route.place,
              sub: route.sub,
              stage: { id: "firstRun", words: mailbox === undefined ? { how } : { how, mailbox } },
            })
          }
        />
      )
    );
  }
  return { Body: Device ? DeviceBody : Body, useSummary };
}
