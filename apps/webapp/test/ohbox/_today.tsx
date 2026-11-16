/**
 * THE OHBOX AS TODAY'S SHELL MOUNTS IT, for a test that hands it inputs by name: `TodaysOhbox` inside the frame
 * (over the host a shell builds from today's inputs), under the mail state and the engine a shell stands it in.
 * `TodayOhbox` takes the inputs the old view took, so a case written against that view's inputs reads the same; it
 * fits under the test's own intl and key providers. The engine is an empty mirror: the Ohbox's rows are the inputs,
 * as they were.
 */
import { createContext, createElement as h, useContext, useMemo, type ReactNode } from "react";
import { useMessages } from "next-intl";
import { NONE } from "@ohmail/app/host";
import { Frame, PLACE_IDS, type FramePlaces } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { EngineProvider } from "../../app/shell/engine";
import { MailStateProvider, type MailboxProbe } from "../../app/shell/MailStateProvider";
import { TodaysOhbox, type TodaysOhboxProps } from "../../app/shell/TodaysOhbox";
import { useTodaysSupplies } from "../../app/shell/todays-supplies";
import { engineOver, storeWith } from "../_view-shell";
import { hostFromTodaysInputs } from "../_todays-shell";

/** The old view's inputs: `pull` may be left out (no Pull new mail), as may the inputs the Ohbox no longer reads. */
export type TodayOhboxProps = Omit<TodaysOhboxProps, "pull"> & {
  pull?: TodaysOhboxProps["pull"];
  /** The mailboxes the mail state reads; left out, the account's mailboxes are not known. */
  mailboxProbe?: MailboxProbe;
  [unread: string]: unknown;
};

const NO_PULL = { available: false, pulling: false, pull: () => undefined };
const Fed = createContext<TodayOhboxProps | null>(null);

/** The wide pane today's views stand in: the Ohbox, fed the test's inputs. */
function Pane(): ReactNode {
  const props = useContext(Fed)!;
  const { mailboxProbe: _probe, pull, ...rest } = props;
  return h(TodaysOhbox, { ...(rest as unknown as TodaysOhboxProps), pull: pull ?? NO_PULL });
}

const PLACES = Object.fromEntries(
  PLACE_IDS.map((id) => [id, { id, body: "today", rail: null, panes: { kind: "wide", Wide: Pane } }]),
) as unknown as FramePlaces;

let shared: Promise<ReturnType<typeof engineOver>> | null = null;
/** One empty mirror for every mount: nothing here reads it but the mail state. */
export function todayEngine(): Promise<ReturnType<typeof engineOver>> {
  shared ??= storeWith([]).then((s) => engineOver(s));
  return shared;
}

function Host({ engine }: { engine: ReturnType<typeof engineOver> }): ReactNode {
  const frame = useTodaysSupplies(NONE);
  const host = useMemo(
    () => hostFromTodaysInputs({ demo: false, engine }, engine, { ...frame, places: PLACES }, NONE),
    [engine, frame],
  );
  return h(Frame, { host });
}

function Words({ children }: { children: ReactNode }): ReactNode {
  const messages = useMessages();
  return h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC", children } as never);
}

let ready: ReturnType<typeof engineOver> | null = null;

/** Today's Ohbox in its frame. One component for every render, so a new render is an update, never a mount. */
function TodayOhbox(props: TodayOhboxProps): ReactNode {
  const engine = ready!;
  return h(Words, null,
    h(EngineProvider, { demo: false, engine } as never,
      h(MailStateProvider, { mirrored: 0, probe: props.mailboxProbe } as never,
        h(Fed.Provider, { value: props }, h(Host, { engine })))));
}

/** Await before the first render (the engine the mail state stands on); every call hands the same component. */
export async function prepareToday(): Promise<(props: TodayOhboxProps) => ReactNode> {
  ready = await todayEngine();
  return TodayOhbox;
}

export { groupIds, headCount, ohboxRow, ohboxRows, openRow, pickedCount } from "./_finders.js";
