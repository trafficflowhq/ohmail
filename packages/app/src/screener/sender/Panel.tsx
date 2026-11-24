/**
 * THE DECISION, in the action panel: the five verbs in their one order, each with its key, the suggested one the
 * panel's ink, and More with the three that also mark read. What stands beside them is said before the press, never
 * after: an install that may not decide draws no verb, only who decides and the way to Mailboxes (a button that
 * cannot act is a small lie); a reader whose organizer files what is decided here says who files it; a sender
 * decided here waits for that organizer; a decision the organizer refused says so.
 */
import { useRef, useState } from "react";
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
  const { commands, plan } = useFrame();
  const narrow = plan.device === "phone" || (plan.device === "fold" && plan.pose !== "land");
  const [folded, setFolded] = useState<readonly string[]>([]);
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
          ? t(narrow ? "place.pendingNamedShort" : "pendingBarTitle", { name: role.name })
          : t(narrow ? "place.pendingUnknownShort" : "pendingBarTitleUnknown"),
      keep: true,
    });
  const offersUnsubscribe = model.unsubClaimOf(open, view.scopeOf(open)) !== "none";
  /* As the sheet draws them: each with its place's sign, the suggested one the ink, the others words that act. */
  const verbs = DECISION_ORDER.map(
    (dest) =>
      ({
        id: dest,
        label:
          narrow && offersUnsubscribe && dest === "screened"
            ? t("place.screenOutPlusUnsub")
            : t(PILE_VERB_KEY[dest]),
        icon: DECISION_ICON[dest],
        keyHint: DECISION_KEY[dest],
        kind: view.accept === dest ? "ink" : undefined,
        rank: dest === "ohbox" || view.accept === dest ? 0 : undefined,
        segment: DECISION_QUIET.has(dest) ? "out" : "in",
        onPress: () => view.decide(dest, false),
      }) satisfies PanelVerb,
  );
  const actionItems: (PanelVerb | PanelNote)[] = [...notes, ...verbs];
  if (!narrow && offersUnsubscribe) {
    actionItems.splice(notes.length + DECISION_ORDER.indexOf("screened"), 0, { note: t("place.plusUnsub") });
  }
  return (
    <>
      <ActionPanel
        label={label}
        items={actionItems}
        onFold={setFolded}
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
        {verbs
          .filter((verb) => folded.includes(verb.id))
          .map((verb) => (
            <MenuItem
              key={verb.id}
              label={verb.label}
              note={
                offersUnsubscribe && DECISION_QUIET.has(verb.id) && (!narrow || verb.id === "spam")
                  ? t("place.plusUnsub")
                  : undefined
              }
              icon={verb.icon}
              keyHint={verb.keyHint}
              onPress={verb.onPress}
            >
              {verb.label}
            </MenuItem>
          ))}
        {DECISION_ORDER.filter((dest) => !DECISION_QUIET.has(dest)).map((dest) => (
          <MenuItem
            key={dest}
            keyHint={`⇧${DECISION_KEY[dest].toUpperCase()}`}
            onPress={() => view.decide(dest, true)}
          >
            {t("barMarkRead", { dest: t(PILE_KEY[dest]) })}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
