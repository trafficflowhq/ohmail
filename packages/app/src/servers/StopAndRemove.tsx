/**
 * FORGET, AND STOP AND REMOVE. A pairing is forgotten on its press. This phone's own mailbox asks first (`forget.ask`)
 * while its store holds what no mail server has (unsent drafts, settings the mailbox lacks) or cannot say, in the
 * kit's dialog: nothing is removed until the person presses its verb, and the removal names the row it was asked for
 * and no other. The keys land on the safe answer, and after a removal that kept the store it opens the mailbox again.
 * What a removal could not take back is native's to say (`after`): this page holds no row of its own.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@ohmail/ui/base";
import {
  stopAndRemoveAsks,
  stopAndRemoveKept,
  stopAndRemoveLines,
  stopAndRemoveVerb,
  type SettingsAtRisk,
  type StopAndRemoveAsk,
} from "@ohmail/app-logic/phone/stop-and-remove";
import type { ServersDoor, ServersForgetAsk } from "./contract.js";
import { useServersWords } from "./namespace.js";

/** The words a risk to settings crosses in. */
const RISKS: readonly SettingsAtRisk[] = ["answer", "newer", "unsaved", "unknown"];
const riskOf = (value: unknown): SettingsAtRisk | null => RISKS.find((risk) => risk === value) ?? null;

/** What removing a row would drop, read by its shape. Anything this page cannot read asks, as a count it cannot read. */
function askedOf(answer: ServersForgetAsk | null): ServersForgetAsk {
  const drafts =
    typeof answer?.drafts === "number" && Number.isSafeInteger(answer.drafts) && answer.drafts >= 0
      ? answer.drafts
      : null;
  return { drafts, settings: answer?.settings === "none" ? "none" : (riskOf(answer?.settings) ?? "unknown") };
}

export interface Asking {
  readonly id: string;
  readonly ask: StopAndRemoveAsk;
}

export interface Removal {
  /** The row the dialog asks about, and what it asks; null while no dialog stands. */
  readonly asking: Asking | null;
  /** A row's verb: Forget at once; Stop and remove asks first where its store holds what no server has. */
  press(row: { readonly id: string; readonly own: boolean }): void;
  /** The dialog's verb: the removal, past the risk it named. */
  confirm(): void;
  /** The dialog's way out: nothing is removed; after a removal that kept the store, the mailbox opens again. */
  keep(): void;
}

export function useRemoval(door: ServersDoor): Removal {
  const [asking, setAsking] = useState<Asking | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const forget = useCallback(
    async (id: string, anyway: boolean) => {
      let forgot: Awaited<ReturnType<ServersDoor["forget"]>> | null;
      try {
        forgot = await door.forget(id, anyway);
      } catch {
        forgot = null;
      }
      if (!live.current || forgot === null) return;
      const settings = forgot.k === "asks" ? riskOf(forgot.settings) : null;
      /* Nothing was removed: the store holds settings the mailbox does not, and the dialog asks about them. */
      if (forgot.k === "asks") setAsking({ id, ask: stopAndRemoveKept(settings ?? "unknown") });
      else if (forgot.k === "gone" && forgot.after === null) {
        // The native row update may arrive before or after the reply. Any other pairing keeps this page open.
        if (door.state.read().paired.every((row) => row.id === id)) door.waysIn("welcome");
      }
    },
    [door],
  );
  const press = useCallback(
    async (row: { readonly id: string; readonly own: boolean }) => {
      if (!row.own) return void forget(row.id, false);
      let answer: ServersForgetAsk | null;
      try {
        answer = await door.forgetAsk(row.id);
      } catch {
        answer = null;
      }
      if (!live.current) return;
      const asked = askedOf(answer);
      const ask = stopAndRemoveAsks(asked.drafts, asked.settings);
      if (ask === null) void forget(row.id, false);
      else setAsking({ id: row.id, ask });
    },
    [door, forget],
  );
  const confirm = useCallback(() => {
    if (asking === null) return;
    setAsking(null);
    void forget(asking.id, asking.ask.settings !== null);
  }, [asking, forget]);
  const keep = useCallback(() => {
    if (asking === null) return;
    setAsking(null);
    if (asking.ask.kept) void door.switchTo(asking.id).catch(() => {});
  }, [asking, door]);
  return { asking, press: (row) => void press(row), confirm, keep };
}

/** The dialog, in the kit's own: its sentence, what the removal would delete, the verb, and the safe answer. */
export function StopAndRemove({ removal }: { readonly removal: Removal }): ReactNode {
  const { t } = useServersWords();
  const asking = removal.asking;
  const lines =
    asking === null
      ? []
      : stopAndRemoveLines(asking.ask).map((line) => t(line.key, "values" in line ? line.values : undefined));
  return (
    <Dialog
      open={asking !== null}
      onClose={removal.keep}
      /* The catalogue's sentence keeps its full stop; the dialog draws the dot. */
      title={t("remove.title").replace(/\.$/, "")}
      hot
      line={lines.length === 0 ? undefined : lines.join(" ")}
      keysOn="cancel"
      confirm={{ label: asking === null ? "" : t(stopAndRemoveVerb(asking.ask)), onPress: removal.confirm }}
      cancel={{ label: t("remove.keep"), keyHint: "↵" }}
    />
  );
}
