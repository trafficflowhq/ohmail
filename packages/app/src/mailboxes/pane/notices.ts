import { isValidElement, type ReactNode } from "react";
import {
  useGapNotices,
  useOrganizerNotices,
  type PaneNotice,
} from "@ohmail/app-logic/mailboxes/pane/notices";
import { useFrame, type FrameNotice } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { settingsSection } from "../../settings/menu.js";
import { useText, type Text } from "../../text/index.js";
import type { PaneMailState } from "./pane.js";

/** Words the catalogue marks for emphasis, as the slot shows them: plain. */
function plainOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return plainOf(node.props.children);
  return "";
}

const plain = (chunks: ReactNode): ReactNode => chunks;

function mailboxRows(t: Text, mailboxes: NonNullable<PaneNotice["mailboxes"]>): string[] {
  return mailboxes.map(({ address, kind, name }) => {
    const holder =
      kind === "stopped"
        ? name
          ? t("noticeRowStopped", { name })
          : t("noticeRowStoppedUnknown")
        : (name ?? t("noticeRowUnknown"));
    return t("noticeMailboxRow", { address, holder });
  });
}

function said(t: Text, n: PaneNotice): FrameNotice {
  const { title } = n;
  const rows = n.mailboxes && mailboxRows(t, n.mailboxes);
  const line = n.line ? t(n.line.key, n.line.values) : undefined;
  const action = (a: PaneNotice["acts"][number]) => ({
    label: t(a.label.key, a.label.values),
    onPress: a.press,
  });
  const [first, second] = n.acts.map(action);
  const face = {
    kind: n.kind,
    ...(n.id === undefined ? {} : { id: n.id }),
    title: title.markup
      ? plainOf(t.rich(title.key, { ...title.values, b: plain, c: plain }))
      : t(title.key, title.values),
    ...(n.hot ? { hot: true } : {}),
    ...(line ? { line } : {}),
  };
  if (rows && !second) {
    return {
      ...face,
      acts: first ? [first] : undefined,
      more: {
        label: t("noticeCountShow"),
        rows,
        ...(n.afterInspect ? { confirm: action(n.afterInspect) } : {}),
      },
    };
  }
  return { ...face, acts: first ? (second ? [first, second] : [first]) : undefined };
}

/**
 * THE MAILBOXES ENTRY'S NOTICES, for the notice slot: the organizer's change and the gap's offer, over the shell's
 * two wires and the ground's facts. Made once with the pane's registration; the frame calls it as the entry's
 * `notice()`.
 */
export function mailboxesNotices(mailState: () => PaneMailState): () => readonly FrameNotice[] {
  return function useMailboxesNotices(): readonly FrameNotice[] {
    const { host, commands } = useFrame();
    const t = useText("mailboxes");
    const mail = mailState();
    const facts = (mail.mailboxes ?? null) as Parameters<typeof useOrganizerNotices>[0]["facts"];
    const refresh = (): void => void mail.refresh();
    const hasMailboxList =
      host.capabilities.mailboxes !== NONE &&
      host.wires.mailboxes !== NONE &&
      settingsSection(host, "mailboxes") === "mailboxes";
    const organizer = useOrganizerNotices({
      facts,
      acknowledge: host.wires.organizerNotice,
      refresh,
      open: hasMailboxList ? () => commands.go({ place: "settings", sub: "mailboxes" }) : NONE,
    });
    const gap = useGapNotices({ facts, answer: host.wires.gapLetters, refresh });
    return [...organizer, ...gap].map((n) => said(t, n));
  };
}
