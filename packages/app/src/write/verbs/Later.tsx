/**
 * SEND LATER: when the letter should go, asked in a card. The presets the shell names (each past the floor and
 * within the files' horizon), a day and a time of the person's own (refused in words before the wire when it is
 * past or too far ahead, the night that skips the typed hour said), the zone the times are in, and, where no time
 * may stand (a forward, files a server will not keep, a file still being read), why, in place of the times.
 * While it stands, Mod+Enter schedules the time it holds (never sends now), and the digits take the presets, 4 the
 * day of one's own.
 */
import { useCallback, useRef, useState } from "react";
import { Button, Field, FieldStack, Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { chordKeys, useModGlyph } from "@ohmail/app-logic/keys";
import "./later.css";
import { localInputValue } from "@ohmail/app-logic/text/format";
import { LATER_CHOICES, SCHEDULE_KEY, laterPlan, type LaterRefusal } from "@ohmail/app-logic/write/later";
import { useText, type Text } from "../../text/index.js";
import { useWriteBeside } from "../above.js";

function refusalWords(t: Text, r: LaterRefusal): string | undefined {
  switch (r.why) {
    case "filesNotHere":
      return t("later.filesNotHere");
    case "filesUnknown":
      return t("later.unavailable");
    case "attaching":
      return t("files.still", { name: r.name, count: r.count });
  }
}

/** The card, standing open; it reads the clock once, when it opens. */
function LaterCard({
  anchor,
  onClose,
  onPick,
  forward,
  hasFiles,
  attaching,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  onPick: (at: string) => void;
  forward: boolean;
  hasFiles: boolean;
  attaching: readonly string[];
}) {
  const t = useText("write");
  const { later } = useWriteBeside();
  const [picking, setPicking] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const [typed, setTyped] = useState(() => later.seed(openedAt));
  const files = later.useFiles(true);
  const floor = later.floor(openedAt);
  const plan = laterPlan({
    openedAt,
    floor,
    forward,
    hasFiles,
    files,
    attaching,
    presets: later.options(openedAt),
    custom: later.compose(typed, floor),
  });
  const pick = (at: string): void => {
    onClose();
    onPick(at);
  };
  const custom = later.compose(typed, floor);
  const own = useRef<HTMLInputElement | null>(null);
  const title = t("later.title");
  const refusal = plan.refusal === null ? undefined : refusalWords(t, plan.refusal);
  const dateField = useCallback((node: HTMLInputElement | null) => {
    own.current = node;
    node?.focus({ preventScroll: true });
  }, []);
  const handleKey = laterKeys(plan.refusal === null, plan.custom?.at ?? null, plan.presets, pick, () => {
    if (picking) own.current?.focus({ preventScroll: true });
    else setPicking(true);
  });
  return (
    <Menu
      open
      portal
      anchor={anchor}
      fit="whole"
      up
      onClose={onClose}
      label={title}
      kind="card"
      title={title}
      aside={t("later.zone", { zone: later.zone() })}
      onKey={(e) => {
        handleKey(e.nativeEvent);
        return e.defaultPrevented || e.nativeEvent.defaultPrevented;
      }}
    >
      {plan.refusal !== null ? (
        refusal === undefined ? null : (
          <MenuNote>{refusal}</MenuNote>
        )
      ) : picking ? (
        <>
          <LaterFields
            typed={typed}
            setTyped={setTyped}
            plan={plan}
            shifted={custom?.shifted}
            pick={pick}
            dateField={dateField}
            onBack={() => setPicking(false)}
          />
        </>
      ) : (
        <>
          {plan.presets.map((p) => (
            <MenuItem
              key={p.id}
              note={later.label(p.at)}
              keyHint={Object.keys(LATER_CHOICES).find(
                (key) => LATER_CHOICES[key as keyof typeof LATER_CHOICES] === p.id,
              )}
              onPress={() => pick(p.at)}
            >
              {t(`later.${p.id}`)}
            </MenuItem>
          ))}
          <MenuItem keyHint="4" onPress={() => setPicking(true)}>
            {t("later.pick")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function LaterFields({
  typed,
  setTyped,
  plan,
  shifted,
  pick,
  dateField,
  onBack,
}: {
  typed: string;
  setTyped: (value: string) => void;
  plan: ReturnType<typeof laterPlan>;
  shifted?: { booked: string; asked: string } | null;
  pick: (at: string) => void;
  dateField: (node: HTMLInputElement | null) => void;
  onBack: () => void;
}) {
  const t = useText("write");
  const mod = useModGlyph();
  const [day = "", clock = ""] = typed.split("T");
  const lastDay =
    plan.latest === null ? undefined : localInputValue(new Date(plan.latest).toISOString()).slice(0, 10);
  return (
    <form
      aria-label={t("later.pick")}
      onSubmit={(e) => {
        e.preventDefault();
        if (plan.custom !== null) pick(plan.custom.at);
      }}
    >
      <FieldStack>
        <Field
          ref={dateField}
          label={t("later.day")}
          type="date"
          max={lastDay}
          value={day}
          onChange={(d) => setTyped(`${d}T${clock}`)}
        />
        <Field
          label={t("later.time")}
          type="time"
          value={clock}
          onChange={(c) => setTyped(`${day}T${c}`)}
          refusal={
            plan.customRefused === "past"
              ? t("later.past")
              : plan.customRefused === "tooFar"
                ? t("later.filesTooFar", { days: plan.horizonDays ?? 0 })
                : undefined
          }
          hint={shifted ? t("later.skipped", { booked: shifted.booked, asked: shifted.asked }) : undefined}
        />
      </FieldStack>
      <div className="write-later-actions">
        <Button
          keyHint={chordKeys("mod+Enter", mod).join(" ")}
          kind="ink"
          size="s"
          disabled={plan.custom === null}
          onPress={() => {
            if (plan.custom !== null) pick(plan.custom.at);
          }}
        >
          {t("later.confirm")}
        </Button>
        <Button kind="quiet" size="s" onPress={onBack}>
          {t("later.back")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The card's keys, read inside it (the card keeps every key from what lies under it): Mod+Enter the time it holds;
 * outside its fields 1 this evening, 2 tomorrow morning, 3 Monday, 4 to a day of one's own.
 */
function laterKeys(
  times: boolean,
  custom: string | null,
  presets: readonly { readonly id: string; readonly at: string }[],
  pick: (at: string) => void,
  own: () => void,
): (e: KeyboardEvent) => void {
  const preset = (id: string): void => {
    const at = presets.find((p) => p.id === id)?.at;
    if (at !== undefined) pick(at);
  };
  return (e) => {
    if (e.key === SCHEDULE_KEY && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (custom !== null) pick(custom);
      return;
    }
    const typing = e.target instanceof HTMLInputElement;
    if (!times || typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!Object.hasOwn(LATER_CHOICES, e.key)) return;
    const choice = LATER_CHOICES[e.key as keyof typeof LATER_CHOICES];
    e.preventDefault();
    if (choice === "custom") own();
    else preset(choice);
  };
}

export function Later(props: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (at: string) => void;
  forward: boolean;
  hasFiles: boolean;
  attaching: readonly string[];
}) {
  return props.anchor === null ? null : <LaterCard {...props} anchor={props.anchor} />;
}
