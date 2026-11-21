import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote } from "@ohmail/ui/mail";
import { placeOfFolder } from "@ohmail/app-logic/reader";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { FILING_REFUSAL_REASONS } from "@ohmail/app-logic/mail-state/mail-state";
import { filingWaits } from "@ohmail/app-logic/mailboxes/pane/filings";
import { selfCheckPressSentence, selfCheckWaiting } from "@ohmail/app-logic/mailboxes/pane/self-check";
import { useFilings, useSelfChecks } from "@ohmail/app-logic/mailboxes/pane/use-checks";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";
import type { RowProps } from "./Row.js";
import { useStamps } from "./say.js";

/** The check against the mail server, one press and one sentence back; and the filings that wait, with their two presses. */
export function Checks(props: RowProps): ReactNode {
  const { m, model, verbs } = props;
  const t = useText("mailboxes");
  const checks = useSelfChecks(model.wire.selfCheck);
  const press = checks.press(m.id);
  const stamps = useStamps();
  const waiting = selfCheckWaiting(m);
  const report = selfCheckPressSentence((key, values) => t(key, values), press);
  const settled = press.k === "read" && report === t("selfCheckInStep");
  const time = settled && press.check.checkedAt ? stamps.when(press.check.checkedAt, model.list.now) : "";
  const value =
    press.k === "busy"
      ? t("checkBusy")
      : settled
        ? time
          ? t("checkInStepAt", { time })
          : t("checkInStep")
        : press.k === "rest"
          ? t("checkNotRun")
          : undefined;
  const sentence = settled
    ? waiting > 0
      ? t("selfCheckWaiting", { count: waiting })
      : null
    : selfCheckPressSentence((key, values) => t(key, values), press, waiting);
  // A block shown in this visit stays to say what its press did, after its filings have cleared.
  const waits = filingWaits(m);
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (waits) setKept(true);
  }, [waits]);
  return (
    <>
      <SettingLine label={t("mailServerCheck")} value={value} valueStatus>
        <Button kind="quiet" size="s" disabled={press.k === "busy"} onPress={() => checks.run(m.id)}>
          {t("checkAction")}
        </Button>
      </SettingLine>
      {sentence !== null ? (
        <div role="status">
          <SettingNote>{sentence}</SettingNote>
        </div>
      ) : null}
      {verbs.filings && model.wire.filings !== NONE && (waits || kept) ? <Filings {...props} /> : null}
    </>
  );
}

function Filings(props: RowProps): ReactNode {
  const { m, model } = props;
  const t = useText("mailboxFilings");
  const sync = useText("sync");
  const place = useText("place");
  const stamps = useStamps();
  const filings = useFilings(model.wire.filings, m, model.refreshMailState);
  const f = m.filing;
  const { route } = useFrame();
  const followed = route.place === "settings" && route.sub === "mailboxes" && route.words.mailbox === m.id;
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const target = heading.current;
    if (!followed || target === null || target.ownerDocument.activeElement === target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "start" });
  }, [followed]);
  const folderName = (folder: string): string => {
    const view = placeOfFolder(folder);
    return view !== null && place.has(view) ? place(view) : folder;
  };
  const reasonWords = (r: string | null): string => {
    const known =
      r !== null && (FILING_REFUSAL_REASONS as readonly string[]).includes(r)
        ? r
        : r === null
          ? "none"
          : "unknown";
    return sync(`filingReason_${known}`);
  };
  return (
    <>
      <h3 className="oh-text" ref={heading} tabIndex={-1}>
        {t("title", { mailbox: m.displayName?.trim() || displayAddress(m.address) })}
      </h3>
      {filings.read.k === "unread" && f ? (
        <SettingNote>{t("unread", { count: f.due + f.deferred })}</SettingNote>
      ) : null}
      {filings.read.k === "read"
        ? filings.read.groups.map((g) => {
            const reasons =
              g.reasons.length === 1
                ? reasonWords(g.reasons[0]!.reason)
                : g.reasons
                    .map((r) => t("reasonCounted", { reason: reasonWords(r.reason), count: r.count }))
                    .join(", ");
            const lines = [
              t("why", { reasons }),
              g.nextAttemptAt ? t("next", { at: stamps.when(g.nextAttemptAt, model.list.now) }) : null,
              g.at ? t("at", { count: g.count, at: folderName(g.at) }) : null,
              g.deletes > 0
                ? t(g.deletes >= g.count ? "deletesAll" : "deletesSome", { count: g.deletes })
                : null,
            ].filter((x): x is string => x !== null);
            return (
              <div key={g.folder} className="mbx-row-lines">
                <SettingLine
                  label={t("group", {
                    count: g.count,
                    folder: folderName(g.folder),
                    since: g.since ? stamps.when(g.since, model.list.now) : "—",
                  })}
                >
                  <Button
                    kind="quiet"
                    size="s"
                    disabled={filings.busy}
                    onPress={() => filings.retry(g.folder)}
                  >
                    {t("retry")}
                  </Button>
                  {g.count > g.deletes ? (
                    <Button
                      kind="quiet"
                      size="s"
                      disabled={filings.busy || g.through === null}
                      onPress={() => g.through !== null && filings.leave(g.folder, g.through)}
                    >
                      {t("leave")}
                    </Button>
                  ) : null}
                </SettingLine>
                <SettingNote>{lines.join(" ")}</SettingNote>
              </div>
            );
          })
        : null}
      {filings.note !== null ? (
        <div role="status">
          <SettingNote>
            {filings.note.k === "retried" || filings.note.k === "left"
              ? t(filings.note.k, { count: filings.note.count })
              : t(filings.note.k)}
          </SettingNote>
        </div>
      ) : null}
    </>
  );
}
