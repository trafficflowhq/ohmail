import { useEffect, useState } from "react";
import { NOTICE_DELAY_MS, noticeDelayPassed } from "@ohmail/app-logic/mail-state/mail-state";
import type { CalendarConnectionRecord } from "@ohmail/wire";
import { useFrame, useNotice } from "../frame/commands.js";
import { useText } from "../text/index.js";

/** First millisecond past the grace period for a scheduled check that has not succeeded. */
export function calendarCheckDeadline(connection: CalendarConnectionRecord): number {
  if (connection.status !== "active" || !connection.nextPollAt) return Infinity;
  const due = Date.parse(connection.nextPollAt);
  if (!Number.isFinite(due) || Date.parse(connection.lastSyncedAt ?? "") >= due) return Infinity;
  return due + NOTICE_DELAY_MS + 1;
}

export function useCalendarConnectionNotice(
  sources: { readonly connections: ReadonlyMap<string, CalendarConnectionRecord> },
  enabled: boolean,
) {
  const { commands } = useFrame();
  const t = useText("calsettings");
  const tf = useText("frame");
  const [hidden, setHidden] = useState<string>();
  const [, tick] = useState(0);
  const connections = enabled ? [...sources.connections.values()] : [];
  const needsSignIn = connections.find(
    (c) =>
      c.status === "reconnect" ||
      (c.status !== "removing" && (c.errorCode === "consent_needed" || c.errorCode === "token_gone")),
  );
  const failing = connections.filter((c) => c.status === "failing" && c.errorCode !== null);
  const now = Date.now();
  const next = Math.min(
    ...failing.map((c) => Date.parse(c.updatedAt) + NOTICE_DELAY_MS).filter((at) => at > now),
    ...connections.map(calendarCheckDeadline).filter((at) => at > now),
  );
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next]);
  const failed = failing.find((c) => noticeDelayPassed(c.updatedAt, now));
  const overdue = connections.find((c) => calendarCheckDeadline(c) <= now);
  const issue = needsSignIn ?? failed ?? overdue;
  const title = needsSignIn
    ? "accounts.noticeSignIn"
    : failed
      ? "accounts.noticeConnection"
      : "accounts.noticeOverdue";
  const id = issue && `${issue.id}:${title}:${needsSignIn || failed ? issue.updatedAt : issue.nextPollAt}`;
  useNotice(
    !issue || hidden === id
      ? null
      : {
          kind: needsSignIn ? "calendarSignIn" : "calendarConnection",
          id: issue.id,
          hot: true,
          title: t(title, { name: issue.label }),
          acts: [
            {
              label: t("accounts.openCalendars"),
              onPress: () =>
                commands.go({
                  place: "calsettings",
                  sub: "calaccounts",
                  words: { account: issue.id },
                }),
            },
            { label: tf("notice.hide"), kind: "quiet", onPress: () => setHidden(id) },
          ],
        },
  );
}
