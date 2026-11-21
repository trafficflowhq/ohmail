/**
 * A SENDER KEPT OUT, in the panel: Screened out offers Allow (to the Ohbox or to News), Spam offers Not spam (back to
 * Waiting, or to the Ohbox). Each is the model's own release, held in its undo window as 1.0.11 holds it. An install
 * that may not move this mailbox's mail draws no verb: who decides, and the way to Mailboxes.
 */
import { viewSender, type ViewRow, type ScreenerView, type SpamRow } from "@ohmail/app-logic/screener";
import { ActionPanel, type PanelVerb } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useText } from "../../text/index.js";
import { useScreener } from "../contract.js";
import { decidesNote } from "./holder.js";

export function KeptPanel({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const { commands } = useFrame();
  const open = view.open;
  if (open === null || view.segment === "waiting") return null;
  const label = t("place.panel");
  const { role } = model;
  if (role.mode !== "organizer") {
    const note = role.mode === "pending" ? t("moveBarTitle") : decidesNote(t, role);
    return (
      <ActionPanel
        label={label}
        items={[
          { note, keep: true },
          {
            id: "mailboxes",
            label: t("readerBarOpenMailboxes"),
            rank: 0,
            onPress: () => commands.go({ place: "settings", sub: "mailboxes" }),
          },
        ]}
      />
    );
  }
  const verbs = keptVerbs(model, view.segment, [open], t);
  const note = t(view.segment === "screened" ? "place.allow" : "place.notSpam");
  return <ActionPanel label={label} items={[{ note, keep: true }, ...verbs]} />;
}

export function keptVerbs(
  model: ReturnType<typeof useScreener>,
  segment: "screened" | "spam",
  rows: readonly ViewRow[],
  t: ReturnType<typeof useText>,
): PanelVerb[] {
  if (model.role.mode !== "organizer") return [];
  if (segment === "screened")
    return (["ohbox", "reads"] as const).map((dest) => ({
      id: dest,
      label: t(dest === "ohbox" ? "pileOhbox" : "pileReads"),
      kind: "soft",
      rank: 0,
      onPress: () => {
        for (const row of rows) model.allowScreened(viewSender(row), dest);
      },
    }));
  return [
    {
      id: "waiting",
      label: t("place.toWaiting"),
      kind: "soft",
      rank: 0,
      onPress: () => {
        for (const row of rows) model.notSpamToWaiting(row as SpamRow);
      },
    },
    {
      id: "ohbox",
      label: t("pileOhbox"),
      kind: "soft",
      rank: 0,
      onPress: () => {
        for (const row of rows) model.notSpamToOhbox(row as SpamRow);
      },
    },
  ];
}

/** What a kept-out section says of the open sender, said as 1.0.11 says it. */
export function KeptLines({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const open = view.open;
  if (open === null || view.segment === "waiting") return null;
  const sender = "pinned" in open ? open.sender : open;
  return view.segment === "screened" ? (
    <p className="oh-text">
      {t("screenedNote", { date: sender.screenedOn ?? sender.time, count: sender.held.length })}
    </p>
  ) : (
    <p className="oh-text">{t("spamNote")}</p>
  );
}
