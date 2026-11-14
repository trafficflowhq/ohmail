/**
 * THE DECISION, in the action panel: the five verbs in their one order, each with its key, the suggested one the
 * panel's ink, and More with the three that also mark read. What stands beside them is said before the press, never
 * after: an install that may not decide draws no verb, only who decides and the way to Mailboxes (a button that
 * cannot act is a small lie); a reader whose organizer files what is decided here says who files it; a sender
 * decided here waits for that organizer; a decision the organizer refused says so.
 */
import { useRef } from "react";
import {
  DECISION_KEY,
  DECISION_ORDER,
  DECISION_QUIET,
  PILE_KEY,
  PILE_VERB_KEY,
  refused,
  viewSender,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { Menu, MenuItem } from "@ohmail/ui/base";
import type { IconName } from "@ohmail/ui/base";
import { ActionPanel, type PanelNote, type PanelVerb } from "@ohmail/ui/mail";
import { useFrame } from "../../frame/commands.js";
import { useText, type Text } from "../../text/index.js";
import { useScreener } from "../contract.js";
import { readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import { decidesNote } from "./holder.js";

/** Each place's sign, as the rail draws the place. */
const DECISION_ICON: Readonly<Record<(typeof DECISION_ORDER)[number], IconName>> = {
  ohbox: "ohbox",
  reads: "news",
  receipts: "receipts",
  screened: "screenout",
  spam: "spam",
};

/** The organizer's refusal words the catalogue holds; any other reads as a refusal with no reason given. */
const REASONS: ReadonlySet<string> = new Set([
  "unauthenticated",
  "conflict",
  "account_erased",
  "stale",
  "unhandled_kind",
  "invalid_payload",
  "wrong_mailbox",
]);

function refusal(t: Text, reason: string | null | undefined): string {
  return reason && REASONS.has(reason)
    ? t("pendingRefused", { reason: t(`pendingReason_${reason}`) })
    : t("pendingRefusedUnknown");
}

export function Panel({ view }: { view: ScreenerView }) {
  const t = useText("screener");
  const model = useScreener();
  const { commands } = useFrame();
  const moreAt = useRef<HTMLElement | null>(null);
  const { role } = model;
  const open = view.open === null ? null : viewSender(view.open);
  const label = t("place.panel");
  if (open === null) return null;
  const decided = view.decided.find((d) => d.sender.id === open.id)?.decision;
  if (decided !== undefined) {
    const note = decided.holder ? t("pendingDecided", { name: decided.holder }) : t("pendingDecidedUnknown");
    return <ActionPanel label={label} items={[{ note, keep: true }]} />;
  }
  if (refused(role)) {
    const note = decidesNote(t, role);
    const mailboxes: PanelVerb = {
      id: "mailboxes",
      label: t("readerBarOpenMailboxes"),
      rank: 0,
      onPress: () => commands.go({ place: "settings", sub: "mailboxes" }),
    };
    return <ActionPanel label={label} items={[{ note, keep: true }, mailboxes]} />;
  }
  const notes: PanelNote[] = [];
  const notApplied = model.notApplied.find((n) => n.sender.id === open.id)?.decision;
  if (notApplied !== undefined) notes.push({ note: refusal(t, notApplied.refusedReason), keep: true });
  else if (role.mode === "pending")
    notes.push({
      note:
        readerHolder(role) === "named"
          ? t("pendingBarTitle", { name: role.name })
          : t("pendingBarTitleUnknown"),
      keep: true,
    });
  /* As the sheet draws them: each with its place's sign, the suggested one the ink, the others words that act. */
  const verbs: PanelVerb[] = DECISION_ORDER.map((dest) => ({
    id: dest,
    label: t(PILE_VERB_KEY[dest]),
    icon: DECISION_ICON[dest],
    keyHint: DECISION_KEY[dest],
    kind: view.accept === dest ? "ink" : undefined,
    rank: dest === "ohbox" || view.accept === dest ? 0 : undefined,
    onPress: () => view.decide(dest, false),
  }));
  return (
    <>
      <ActionPanel
        label={label}
        items={[...notes, ...verbs]}
        more={{
          label: t("place.more"),
          behind: true,
          expanded: view.shown === "more",
          onPress: (at) => {
            moreAt.current = at;
            view.show(view.shown === "more" ? null : "more");
          },
        }}
      />
      <Menu
        open={view.shown === "more"}
        onClose={() => view.show(null)}
        anchor={moreAt}
        label={t("place.more")}
        up
        right
      >
        {DECISION_ORDER.filter((dest) => !DECISION_QUIET.has(dest)).map((dest) => (
          <MenuItem
            key={dest}
            keyHint={`⇧${DECISION_KEY[dest].toUpperCase()}`}
            onPress={() => view.decide(dest, true)}
          >
            {t("barMarkRead", { dest: t(PILE_KEY[dest]) })}
          </MenuItem>
        ))}
        <MenuItem keyHint="s" onPress={() => view.show("card")}>
          {t("place.keyCard")}
        </MenuItem>
      </Menu>
    </>
  );
}
