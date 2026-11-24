import { refusalOf, watchAwayApplied, type AwayResponderWire } from "../away/watch-applied.js";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useEffect, useRef, useState } from "react";
import { useLocale, useText } from "../../text/index.js";
import { DatePicker } from "../../calendar/DatePicker.js";
import {
  AWAY_START,
  awayPileChoices,
  awayStep,
  AwayPane,
  useAwayLeave,
  type AwayEvent,
  type AwayModel,
  type AwayRow,
  type AwayRules,
  type AwayState,
} from "../away/index.js";
import { useFrame } from "../../frame/index.js";
import type { HostWires, None } from "../../host/index.js";
import { dayEnd, dayStamp, dayValue, tomorrowNine } from "@ohmail/app-logic/text/format";
import { noteOf } from "@ohmail/app-logic/consent/travelled-change";

type AwayTransport = Exclude<HostWires["away"], None>;

/** A row as the server answered it; a server one release older answers no scope, which reads as the default. */
function rowOf(wire: AwayResponderWire, rules: AwayRules): AwayRow {
  return {
    enabled: wire.enabled,
    body: wire.body,
    startsAt: wire.startsAt,
    endsAt: wire.endsAt,
    audience: wire.audience,
    throttle: wire.throttle,
    piles: wire.piles ?? [...rules.defaults],
  };
}

export interface AwaySettingsProps {
  wire: AwayTransport;
  runsOn: AwayModel["runsOn"];
  rules: AwayRules;
  piles: Parameters<typeof awayPileChoices>[0];
}

export function AwaySettings({ wire, runsOn, rules, piles }: AwaySettingsProps) {
  const { host } = useFrame();
  const owner = host.session.scope;
  const t = useText("away");
  const tOhbox = useText("ohbox");
  const tScreener = useText("screener");
  const locale = useLocale();
  const { state, saved, draft, step, anchor, setAnchor, leave, save } = useAwayControls(
    wire,
    owner,
    rules,
    host.device.address,
  );
  const endsAt = draft?.endsAt ?? null;
  const picker = anchor ? (
    <DatePicker
      locale={locale}
      today={dayValue(new Date().toISOString())}
      min={dayValue(tomorrowNine(new Date()))}
      value={endsAt === null ? null : dayValue(endsAt)}
      anchor={anchor}
      labels={{
        dialog: t("untilPick"),
        prevMonth: tOhbox("datePrevMonth"),
        nextMonth: tOhbox("dateNextMonth"),
        today: tScreener("today"),
      }}
      onPick={(day) => {
        setAnchor(null);
        step({ kind: "edit", patch: { endsAt: dayEnd(day) } });
      }}
      onClose={() => setAnchor(null)}
    />
  ) : null;

  const model: AwayModel = {
    state,
    piles: draft ? awayPileChoices(piles, draft, rules) : [],
    runsOn,
    endsSaid: {
      draft: draft?.endsAt ? dayStamp(draft.endsAt) : null,
      saved: saved?.endsAt ? dayStamp(saved.endsAt) : null,
    },
    savedEnded:
      saved !== null &&
      saved.enabled &&
      saved.endsAt !== null &&
      new Date(saved.endsAt).getTime() < Date.now(),
    ...leave,
    edit: (patch) => step({ kind: "edit", patch }),
    pickEnd: (at) => setAnchor((open) => (open ? null : at)),
    save,
  };
  return (
    <>
      <AwayPane model={model} rules={rules} />
      {picker}
    </>
  );
}

function useAwayControls(
  wire: AwayTransport,
  owner: string | null,
  rules: AwayRules,
  address: Parameters<typeof useAwayLeave>[0],
) {
  const [state, setState] = useState<AwayState>(AWAY_START);
  const held = useRef(state);
  const step = (event: AwayEvent): AwayState => {
    const next = awayStep(held.current, event, rules);
    held.current = next;
    setState(next);
    return next;
  };
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Which save the pane waits on: a watcher whose generation is stale decides nothing. */
  const saveGen = useRef(0);
  const load = useStableCallback(() => {
    let current = true;
    alive.current = true;
    void wire.state().then(
      (loaded) => {
        if (current) step({ kind: "loaded", row: rowOf(loaded, rules), refused: refusalOf(loaded) });
      },
      () => {
        if (current) step({ kind: "unreadable" });
      },
    );
    return () => {
      current = false;
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  });
  useEffect(() => {
    if (owner !== null) return load();
  }, [owner, wire, load]);

  const { saved, draft } = state;
  const leave = useAwayLeave(address, state, rules, () => step({ kind: "discard" }));
  const watchForApplied = (askedAt: string | null, gen: number): void => {
    if (owner === null) return;
    watchAwayApplied(
      wire,
      askedAt,
      () => alive.current && gen === saveGen.current,
      timer,
      (response, refused) => step({ kind: "heard", row: refused ? null : rowOf(response, rules), refused }),
    );
  };

  const save = (): void => {
    if (owner === null) return;
    const before = held.current;
    const next = step({ kind: "save", now: Date.now() });
    if (!next.pending || before.pending || next.asked === null) return;
    const gen = ++saveGen.current;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const asked = next.asked;
    void wire.save({ ...asked, piles: asked.piles as Parameters<AwayTransport["save"]>[0]["piles"] }).then(
      (echoed) => {
        if (!alive.current) return;
        const row = rowOf(echoed, rules);
        step({ kind: "echoed", row, travelled: echoed.pending === true });
        if (echoed.pending === true) watchForApplied(echoed.updatedAt, gen);
      },
      () => {
        if (alive.current) step({ kind: "refusedWrite" });
      },
    );
  };
  return { state, saved, draft, step, anchor, setAnchor, leave, save };
}
