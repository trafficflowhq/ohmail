/**
 * ONE INVITATION IN THE PANEL: its row, with the answers on the open row, and under the open one its facts. A
 * calendar that can only be looked at shows the answer given as a tag and draws no answers; a cancelled one is struck
 * and offers nothing. Where the answer waits, and why a write was not saved, are said from the row itself.
 */
import { Button, RefusalLine, Tag } from "@ohmail/ui/base";
import { AgendaRow, EventCard, type CalendarTone } from "@ohmail/ui/calendar";
import { FAULT_KEYS, REFUSAL_KEYS } from "@ohmail/app-logic/calendar";
import type { InvitationAnswer, InvitationRow } from "@ohmail/app-logic/calendar/invitations";
import { useLocale, useText } from "../text/index.js";
import { whenOf } from "./words.js";

import { AnswerChoices, isAnswer } from "./AnswerChoices.js";

export interface InvitationItemProps {
  readonly row: InvitationRow;
  readonly open: boolean;
  readonly today: string;
  readonly calendar: { readonly name: string; readonly tone: CalendarTone };
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onAnswer: (answer: InvitationAnswer) => void;
  readonly onRetry: (row: InvitationRow) => void;
  readonly onLetGo: (writeId: string) => void;
}

/** Why the last write of this invitation was not saved, as a sentence of the event's namespace. */
function faultKey(refusal: NonNullable<InvitationRow["refusal"]>): string {
  return refusal in FAULT_KEYS
    ? FAULT_KEYS[refusal as keyof typeof FAULT_KEYS]
    : REFUSAL_KEYS[refusal as keyof typeof REFUSAL_KEYS];
}

export function InvitationItem(p: InvitationItemProps) {
  const t = useText("invitations");
  const e = useText("event");
  const locale = useLocale();
  const { row } = p;
  const uncertain = row.refusal === "answer_unconfirmed";
  const when = whenOf(row.when, row.day, p.today, locale, t);
  const waits = !row.cancelled && row.answer === "none";
  const given = isAnswer(row.answer) ? row.answer : null;
  const answers =
    !row.cancelled && !row.viewOnly && p.open ? (
      <AnswerChoices answer={row.answer} onAnswer={p.onAnswer} />
    ) : undefined;
  const after = row.replyUnconfirmed
    ? e("replyUnconfirmed")
    : row.waiting !== null
      ? e(`waiting.${row.waiting}`)
      : row.cancelled
        ? t("cancelled")
        : row.organizer;
  return (
    <>
      <AgendaRow
        mark={{ kind: "calendar", tone: p.calendar.tone }}
        title={row.title}
        time=""
        second={`${when} · ${after}`}
        {...(given && (!p.open || row.viewOnly) ? { tag: <Tag>{t(`answer.${given}`)}</Tag> } : {})}
        waits={waits}
        off={row.cancelled}
        quiet={given === "declined"}
        open={p.open}
        tail={answers}
        onOpen={p.onOpen}
      />
      {p.open ? (
        <EventCard
          frame="inline"
          neutralHead
          title={row.title}
          tone={p.calendar.tone}
          when={whenOf(row.when, row.day, p.today, locale, t, true)}
          {...(row.place ? { where: [{ text: row.place }] } : {})}
          tags={[
            ...(row.cancelled ? [{ text: t("cancelled"), hot: true }] : []),
            /* A card set into a list draws no head act: why it cannot be answered stands with its tags. */
            ...(row.viewOnly
              ? [{ text: e(row.connectionStopped ? "refusal.connection" : "refusal.readOnly") }]
              : []),
          ]}
          close={{ label: t("close"), onPress: p.onClose }}
          rows={[
            { label: t("from"), text: row.organizer },
            { label: t("calendar"), tone: p.calendar.tone, text: p.calendar.name },
            ...(row.refusal === null
              ? []
              : [
                  {
                    ...(uncertain
                      ? { label: e("replyUnconfirmed"), note: e("replyMayNotHaveReachedOrganizer") }
                      : { label: e("notSaved"), text: e(faultKey(row.refusal)) }),
                    ...(row.refusedWriteId === null ? {} : { children: <Ways {...p} /> }),
                  },
                ]),
          ]}
        />
      ) : null}
    </>
  );
}

function Ways({ row, onRetry, onLetGo }: Pick<InvitationItemProps, "row" | "onRetry" | "onLetGo">) {
  const t = useText("invitations");
  const e = useText("event");
  const id = row.refusedWriteId;
  const resendReply = row.refusal === "answer_unconfirmed";
  if (id === null || (resendReply && (row.cancelled || row.viewOnly))) return null;
  return (
    <>
      <Button kind="two" size="s" onPress={() => onRetry(row)}>
        {resendReply ? e("sendReplyAgain") : t("sendAgain")}
      </Button>
      {!resendReply && (
        <Button kind="quiet" size="s" onPress={() => onLetGo(id)}>
          {t("letGo")}
        </Button>
      )}
    </>
  );
}

export function InvitationRefusal(p: Pick<InvitationItemProps, "row" | "onRetry" | "onLetGo">) {
  const t = useText("event");
  const fault = p.row.refusal;
  if (!fault) return null;
  if (fault === "answer_unconfirmed")
    return (
      <div>
        <p className="cal-invitation-detail">{t("replyUnconfirmed")}</p>
        <p className="cal-invitation-detail">{t("replyMayNotHaveReachedOrganizer")}</p>
        <Ways {...p} />
      </div>
    );
  return (
    <div>
      <RefusalLine>{t(faultKey(fault))}</RefusalLine>
      <Ways {...p} />
    </div>
  );
}
