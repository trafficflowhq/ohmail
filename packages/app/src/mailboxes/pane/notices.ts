import { isValidElement, type ReactNode } from "react";
import {
  MAX_NOTICE_MAILBOXES,
  useGapNotices,
  useOrganizerNotices,
  type PaneNotice,
} from "@ohmail/app-logic/mailboxes/pane/notices";
import { useFrame, type FrameNotice } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { settingsSection } from "../../mail/panes.js";
import { useLocale, useText, type Locale, type Text } from "../../text/index.js";
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

function mailboxList(t: Text, locale: Locale, mailboxes: NonNullable<PaneNotice["mailboxes"]>): string {
  const rows = mailboxes.slice(0, MAX_NOTICE_MAILBOXES).map(({ address, kind, name }) => {
    const holder =
      kind === "stopped"
        ? name
          ? t("noticeRowStopped", { name })
          : t("noticeRowStoppedUnknown")
        : (name ?? t("noticeRowUnknown"));
    return t("noticeMailboxRow", { address, holder });
  });
  const count = mailboxes.length - rows.length;
  if (count > 0) rows.push(t("noticeOtherMailboxes", { count }));
  const list = new Intl.ListFormat(locale === "en" ? "en-GB" : locale).format(rows);
  return t("noticeMailboxList", { list });
}

function said(t: Text, locale: Locale, n: PaneNotice): FrameNotice {
  const { title } = n;
  const line = [
    n.mailboxes ? mailboxList(t, locale, n.mailboxes) : "",
    n.line ? t(n.line.key, n.line.values) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const [first, second] = n.acts.map((a) => ({ label: t(a.label.key, a.label.values), onPress: a.press }));
  return {
    kind: n.kind,
    ...(n.id === undefined ? {} : { id: n.id }),
    title: title.markup
      ? plainOf(t.rich(title.key, { ...title.values, b: plain, c: plain }))
      : t(title.key, title.values),
    ...(n.hot ? { hot: true } : {}),
    ...(line ? { line } : {}),
    ...(first ? { acts: second ? ([first, second] as const) : ([first] as const) } : {}),
  };
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
    const locale = useLocale();
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
    return [...organizer, ...gap].map((n) => said(t, locale, n));
  };
}
