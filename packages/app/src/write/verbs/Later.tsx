/**
 * SEND LATER: when the letter should go, asked in a card. The presets the shell names (each past the floor and
 * within the files' horizon), a day and a time of the person's own (refused in words before the wire when it is
 * past or too far ahead, the night that skips the typed hour said), the zone the times are in, and, where no time
 * may stand (a forward, files a server will not keep, a file still being read), why, in place of the times.
 * While it stands, Mod+Enter schedules the time it holds (never sends now), and the digits take the presets, 4 the
 * day of one's own.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Field, Menu, MenuItem, MenuNote } from "@ohmail/ui/base";
import { laterPlan, type LaterRefusal } from "@ohmail/app-logic/write/later";
import { useText, type Text } from "../../text/index.js";
import { useWriteBeside } from "../above.js";

function presetWords(t: Text, id: string, when: string): string {
  switch (id) {
    case "evening":
      return t("later.evening", { when });
    case "tomorrow":
      return t("later.tomorrow", { when });
    case "monday":
      return t("later.monday", { when });
    default:
      return t("later.at", { when });
  }
}

function refusalWords(t: Text, r: LaterRefusal): string {
  switch (r.why) {
    case "forward":
      return t("later.noForwards");
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
  onClose,
  onPick,
  forward,
  hasFiles,
  attaching,
}: {
  onClose: () => void;
  onPick: (at: string) => void;
  forward: boolean;
  hasFiles: boolean;
  attaching: readonly string[];
}) {
  const t = useText("write");
  const { later } = useWriteBeside();
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
  const [day = "", clock = ""] = typed.split("T");
  const custom = later.compose(typed, floor);
  const own = useRef<HTMLFormElement | null>(null);
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = laterKeys(plan.refusal === null, plan.custom?.at ?? null, plan.presets, pick, () =>
    own.current?.querySelector("input")?.focus({ preventScroll: true }),
  );
  /* On the card itself, before it keeps the key from what lies under it. */
  useEffect(() => {
    const card = own.current?.closest('[role="dialog"], [role="menu"]');
    if (!card) return undefined;
    const listen = (e: Event): void => keys.current(e as KeyboardEvent);
    card.addEventListener("keydown", listen);
    return () => card.removeEventListener("keydown", listen);
  }, []);
  return (
    <Menu open onClose={onClose} label={t("later.title")} kind="card" title={t("later.what")}>
      {plan.refusal !== null ? (
        <MenuNote>{refusalWords(t, plan.refusal)}</MenuNote>
      ) : (
        <>
          {plan.presets.map((p) => (
            <MenuItem key={p.id} icon="later" onPress={() => pick(p.at)}>
              {presetWords(t, p.id, later.label(p.at))}
            </MenuItem>
          ))}
          <form
            ref={own}
            aria-label={t("later.pick")}
            onSubmit={(e) => {
              e.preventDefault();
              if (plan.custom !== null) pick(plan.custom.at);
            }}
          >
            <Field
              label={t("later.day")}
              type="date"
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
              hint={
                custom?.shifted
                  ? t("later.skipped", { booked: custom.shifted.booked, asked: custom.shifted.asked })
                  : undefined
              }
            />
            <Button
              kind="ink"
              size="s"
              disabled={plan.custom === null}
              onPress={() => {
                if (plan.custom !== null) pick(plan.custom.at);
              }}
            >
              {t("later.confirm")}
            </Button>
          </form>
          <MenuNote>{t("later.zone", { zone: later.zone() })}</MenuNote>
          {plan.horizonDays !== null ? (
            <MenuNote>{t("later.filesDays", { days: plan.horizonDays })}</MenuNote>
          ) : null}
          {plan.thisComputer ? <MenuNote>{t("later.thisComputer")}</MenuNote> : null}
        </>
      )}
      <MenuItem icon="back" onPress={onClose}>
        {t("later.back")}
      </MenuItem>
    </Menu>
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
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (custom !== null) pick(custom);
      return;
    }
    const typing = e.target instanceof HTMLInputElement;
    if (!times || typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = { "1": "evening", "2": "tomorrow", "3": "monday" }[e.key];
    if (id !== undefined) {
      e.preventDefault();
      preset(id);
    } else if (e.key === "4") {
      e.preventDefault();
      own();
    }
  };
}

export function Later(props: {
  open: boolean;
  onClose: () => void;
  onPick: (at: string) => void;
  forward: boolean;
  hasFiles: boolean;
  attaching: readonly string[];
}) {
  return props.open ? <LaterCard {...props} /> : null;
}
