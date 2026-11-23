import { refusalOf, watchAwayApplied, type AwayResponderWire } from "./watch-applied.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { DatePicker } from "../../calendar/DatePicker.js";
import {
  AWAY_ANSWERABLE_PILES,
  AWAY_PILE_VIEW,
  AWAY_PILES_DEFAULT,
  awayEffectivePiles,
  type AwayPile,
} from "@ohmail/app-logic/away";
import {
  AWAY_START,
  awayPileChoices,
  awayStep,
  type AwayEvent,
  type AwayModel,
  type AwayRow,
  type AwayRules,
  type AwayState,
} from "./model.js";
import { useAwaySchedule } from "./schedule.js";
import { AwayPane } from "./AwayPane.js";
import { useAwayLeave } from "./use-away-leave.js";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { dayEnd, dayStamp, dayValue, tomorrowNine } from "@ohmail/app-logic/text/format";

const AWAY_RULES: AwayRules = {
  defaults: AWAY_PILES_DEFAULT,
  effective: (piles, audience) => awayEffectivePiles(piles as readonly AwayPile[], audience),
};

/** A row as the server answered it; a server one release older answers no scope, which reads as the default. */
function rowOf(wire: AwayResponderWire): AwayRow {
  return {
    enabled: wire.enabled,
    body: wire.body,
    startsAt: wire.startsAt,
    endsAt: wire.endsAt,
    audience: wire.audience,
    throttle: wire.throttle,
    piles: wire.piles ?? [...AWAY_PILES_DEFAULT],
  };
}

/** The frame remounts this pane when the signed-in account changes. */
export function AwaySettings() {
  return <AwayConfiguration />;
}

export function PhoneAwaySettings() {
  return <AwayConfiguration phone />;
}

function AwayConfiguration({ phone = false }: { phone?: boolean }) {
  const { host } = useFrame();
  const wire = host.wires.away;
  const runsOn = host.capabilities.awayRunsOn;
  const locale = useLocale();
  const zone = useTimeZone();
  const t = useText("away");
  const tOhbox = useText("ohbox");
  const tScreener = useText("screener");
  const { state, saved, draft, step, anchor, setAnchor, leave, drop, save } = useAwayControls(
    wire,
    host.device.address,
  );
  const { ended } = useAwaySchedule(saved);
  if (wire === NONE || runsOn === NONE) return null;
  const endsAt = draft?.endsAt ?? null;
  const now = new Date();
  const picker = anchor ? (
    <DatePicker
      locale={locale}
      today={dayValue(now.toISOString(), zone)}
      min={dayValue(tomorrowNine(now, zone), zone)}
      value={endsAt === null ? null : dayValue(endsAt, zone)}
      anchor={anchor}
      labels={{
        dialog: t("untilPick"),
        prevMonth: tOhbox("datePrevMonth"),
        nextMonth: tOhbox("dateNextMonth"),
        today: tScreener("today"),
      }}
      onPick={(day) => {
        setAnchor(null);
        step({ kind: "edit", patch: { endsAt: dayEnd(day, zone) } });
      }}
      onClose={() => setAnchor(null)}
    />
  ) : null;

  const model: AwayModel = {
    state,
    piles: draft
      ? awayPileChoices(
          AWAY_ANSWERABLE_PILES.map((pile) => ({ pile, word: AWAY_PILE_VIEW[pile] })),
          draft,
          AWAY_RULES,
        )
      : [],
    runsOn,
    endsSaid: {
      draft: draft?.endsAt ? dayStamp(draft.endsAt, locale, zone) : null,
      saved: saved?.endsAt ? dayStamp(saved.endsAt, locale, zone) : null,
    },
    savedEnded: ended,
    ...leave,
    edit: (patch) => step({ kind: "edit", patch }),
    pickEnd: (at) => setAnchor((open) => (open ? null : at)),
    save,
  };
  return (
    <>
      <AwayPane model={model} rules={AWAY_RULES} discardEdit={phone ? drop : undefined} />
      {picker}
    </>
  );
}

function useAwayControls(
  wire: Parameters<typeof watchAwayApplied>[0] | typeof NONE,
  address: Parameters<typeof useAwayLeave>[0],
) {
  const [state, setState] = useState<AwayState>(AWAY_START);
  const held = useRef(state);
  const step = (event: AwayEvent): AwayState => {
    const next = awayStep(held.current, event, AWAY_RULES);
    held.current = next;
    setState(next);
    return next;
  };
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Which save the pane waits on: a watcher whose generation is stale decides nothing. */
  const saveGen = useRef(0);
  const invalidateSave = useCallback(() => {
    ++saveGen.current;
  }, []);
  useEffect(() => {
    if (wire === NONE) return;
    let current = true;
    alive.current = true;
    void (wire.initialState?.() ?? wire.state()).then(
      (loaded) => {
        if (current) step({ kind: "loaded", row: rowOf(loaded), refused: refusalOf(loaded) });
      },
      () => {
        if (current) step({ kind: "unreadable" });
      },
    );
    return () => {
      current = false;
      alive.current = false;
      invalidateSave();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [wire, invalidateSave]);

  const { saved, draft } = state;
  const drop = () => {
    step({ kind: "discard" });
  };
  const leave = useAwayLeave(address, state, AWAY_RULES, drop);
  const watchForApplied = (askedAt: string | null, gen: number): void => {
    if (wire === NONE) return;
    watchAwayApplied(
      wire,
      askedAt,
      () => alive.current && gen === saveGen.current,
      timer,
      (response, refused) => step({ kind: "heard", row: refused ? null : rowOf(response), refused }),
    );
  };

  const save = (): void => {
    if (wire === NONE) return;
    const before = held.current;
    const next = step({ kind: "save", now: Date.now() });
    if (!next.pending || before.pending || next.asked === null) return;
    const gen = ++saveGen.current;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const asked = next.asked;
    void wire.save({ ...asked, piles: asked.piles as AwayPile[] }).then(
      (echoed) => {
        if (!alive.current || gen !== saveGen.current) return;
        const row = rowOf(echoed);
        step({ kind: "echoed", row, travelled: echoed.pending === true });
        if (echoed.pending === true) watchForApplied(echoed.updatedAt, gen);
      },
      () => {
        if (alive.current && gen === saveGen.current) step({ kind: "refusedWrite" });
      },
    );
  };

  return { state, saved, draft, step, anchor, setAnchor, leave, drop, save };
}
