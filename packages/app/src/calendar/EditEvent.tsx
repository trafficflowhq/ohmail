import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import {
  readerZones,
  type CalendarConnectionRecord,
  type CalendarEventRecord,
  type CalendarPort,
  type CalendarRecord,
} from "@ohmail/app-logic/calendar";
import { Button, RefusalLine } from "@ohmail/ui/base";
import type { PanelVerb } from "@ohmail/ui/mail";
import { EditorActionBar } from "./EditorActionBar.js";
import { EventCard, QuestionBeforeAct } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import type { CardPlacement } from "./use-event-placement.js";
import { useEditLeave } from "./use-edit-leave.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { DraftFields } from "./DraftFields.js";
import { useDiscardReport, useOpenNewDraft } from "./draft-undo.js";
import {
  draftDiffers,
  draftForDuplicate,
  draftOfRecord,
  draftTimeChanged,
  editCopy,
  eventChanges,
  sentInvitees,
} from "./edit-draft.js";
import { draftTimes, type EventDraft } from "./event-draft.js";
import { DraftTimeNotice } from "./DraftTimeNotice.js";
import { draftWhen, eventWhen, guestNames } from "./event-words.js";
import { editScopeLine, repeatLine } from "./EventActionQuestion.js";
import type { EditableEvent } from "./editable-event.js";
import type { CalendarEventFace } from "./faces.js";

interface Props {
  readonly port: CalendarPort;
  readonly actionItems: readonly PanelVerb[];
  readonly connection: CalendarConnectionRecord | undefined;
  readonly scopeAnchor?: HTMLElement;
  readonly original: CalendarEventRecord;
  readonly exception: CalendarEventRecord | null;
  readonly allowed: () => EditableEvent | null;
  readonly calendar: CalendarRecord;
  readonly face: CalendarEventFace;
  readonly when: string;
  readonly today: string;
  readonly recovered?: EventDraft;
  readonly card: RefObject<HTMLDivElement | null>;
  readonly placement?: CardPlacement;
  readonly beforeRestore: RefObject<(() => void) | null>;
  readonly finish: () => void;
}

export function EditEvent({
  port,
  actionItems,
  connection,
  original,
  exception,
  allowed,
  calendar,
  face,
  when,
  today,
  recovered,
  beforeRestore,
  card,
  placement,
  scopeAnchor,
  finish,
}: Props) {
  const provider = connection?.provider;
  const ordinaryOnly = allowed()?.sharedCopy === true;
  const { commands, plan } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const [shown] = useState(() => ({ ...editCopy(exception ?? original, face), repeat: original.repeat }));
  const [initial] = useState(() => draftOfRecord(shown, zone));
  const [draft, setDraft] = useState(recovered ?? initial.draft);
  const discardReport = useDiscardReport(port);
  const duplicate = useOpenNewDraft(port);
  const dirty = draftDiffers(draft, initial.draft);
  const reportDraft = () => discardReport({ kind: "edit", draft, original: exception ?? original });
  const onLeave = dirty ? reportDraft : () => undefined;
  usePreserveEdit(beforeRestore, draftDiffers(draft, recovered ?? initial.draft), reportDraft);
  const patch = eventChanges(shown, draft, calendar, zone, provider === "caldav");
  const saving = useEditLeave(port, original, shown, draft, allowed, patch, face.ref.occurrence, {
    dirty,
    finish,
    onLeave,
  });
  const { busy, conflict, clear, discard, question, scopeAsked, submit } = saving;
  const blocked = busy || scopeAsked || question !== null;
  const ready = !blocked && !conflict && patch !== null && Object.keys(patch).length > 0;
  const cancelEdit = () => {
    if (blocked) return;
    onLeave();
    discard();
  };
  const change = (edit: Partial<EventDraft>) => {
    setDraft((previous) => ({ ...previous, ...edit }));
    clear();
  };
  const sourceZone = original.start.kind === "instant" ? "UTC" : original.start.zone;
  const panel = (
    <EditorActionBar
      items={actionItems}
      close={() => commands.event(null)}
      duplicate={() => duplicate(draftForDuplicate(shown, face, zone), calendar.id)}
      blocked={blocked}
      ordinaryOnly={ordinaryOnly}
      timeZone={
        initial.timeEditable && !original.repeat && !draft.allDay
          ? (draft.zone ?? sourceZone ?? zone)
          : undefined
      }
      draft={draft}
      change={change}
    />
  );
  const phone = plan.device === "phone";
  return (
    <>
      <EventCard
        ref={card}
        {...placement}
        title={t("edit.event")}
        tone={face.tone}
        frame={phone ? "sheet" : "card"}
        foot={phone ? panel : undefined}
        titleInput={{
          label: t("create.name"),
          value: draft.title,
          onChange: (title) => change({ title }),
          readOnly: blocked,
        }}
        close={{ label: t("closeEvent"), onPress: () => commands.event(null) }}
        onKeyDown={(event) => editorKeys(event, ready, cancelEdit, submit)}
        editor={
          <EditorContents
            {...{
              draft,
              today,
              calendar,
              tone: face.tone,
              original,
              shown,
              connection,
              change,
              cancelEdit,
              ready,
              when,
              blocked,
              saving,
              allowed,
              ordinaryOnly,
            }}
            zone={draft.zone ?? sourceZone ?? zone}
            timeEditable={initial.timeEditable}
            issue={
              draftTimeChanged(draft, initial.draft) ? draftTimes(draft, draft.zone ?? zone).issue : null
            }
          />
        }
      />
      {!phone && <div className="cal-event-panel cal-edit-panel">{panel}</div>}
      <EditQuestions anchor={card} {...saving} {...{ scopeAnchor, draft, original, exception }} />
    </>
  );
}

function EditorContents({
  draft,
  today,
  calendar,
  tone,
  original,
  connection,
  change,
  cancelEdit,
  ready,
  when,
  blocked,
  saving,
  shown,
  allowed,
  ordinaryOnly,
  zone,
  timeEditable,
  issue,
}: Pick<Props, "today" | "calendar" | "original" | "connection" | "when"> & {
  draft: EventDraft;
  tone: CalendarEventFace["tone"];
  change: (edit: Partial<EventDraft>) => void;
  cancelEdit: () => void;
  ready: boolean;
  blocked: boolean;
  saving: ReturnType<typeof useEditLeave>;
  shown: CalendarEventRecord;
  allowed: Props["allowed"];
  ordinaryOnly: boolean;
  zone: string;
  timeEditable: boolean;
  issue: ReturnType<typeof draftTimes>["issue"];
}) {
  const t = useText("calendar");
  const provider = connection?.provider;
  const { failure, conflict, busy, mine, discard, submit } = saving;
  const { host } = useFrame();
  const locale = useLocale();
  const current = conflict ? allowed() : null;
  const latest = current?.exception ?? current?.record;
  return (
    <>
      <div inert={blocked}>
        <DraftTimeNotice issue={issue} />
        {!ordinaryOnly && provider === "caldav" && !calendar.autoSchedule && (
          <RefusalLine start>{t("edit.noInvitations")}</RefusalLine>
        )}
        <DraftFields
          {...{ draft, today, calendar, tone, change }}
          choices={[]}
          ordinaryOnly={ordinaryOnly}
          repeatShapes={connection?.repeatShapes}
          placeSource={original.id}
          cancel={{ label: t("edit.cancel"), onPress: cancelEdit }}
          submit={{ label: t("edit.save"), keyHint: "↵", disabled: !ready, onPress: submit }}
          fixedTime={timeEditable ? undefined : when}
          timeZone={zone}
          edit={{
            sentGuests: sentInvitees(host.engine.store.get<CalendarEventRecord>("calendar_event", shown.id)),
            canInvite:
              !ordinaryOnly &&
              (provider !== "caldav" || calendar.autoSchedule === true) &&
              !original.repeat &&
              original.invitees.every(
                ({ address, role }) =>
                  address.toLowerCase() === original.organizer?.address.toLowerCase() ||
                  role === "optional" ||
                  role === "required",
              ),
            canAddAlert: !ordinaryOnly && original.alarms.every(({ method }) => method === "notice"),
            canAddSecondAlert: !ordinaryOnly && provider !== "microsoft" && !draft.allDay,
            showCall: !ordinaryOnly && provider === "caldav",
          }}
        />
      </div>
      {failure && (
        <div className="cal-edit-failure">
          <RefusalLine start>{failure}</RefusalLine>
          {latest && latest.updatedAt !== original.updatedAt && (
            <dl className="cal-edit-conflict">
              <dt>{t("edit.mine")}</dt>
              <dd className="cal-edit-conflict-copy">
                {draft.title} · {draftWhen(draft, locale)}
              </dd>
              <dt>{t("edit.theirs")}</dt>
              <dd className="cal-edit-conflict-copy">
                {latest.title} · {eventWhen(latest, zone, readerZones(), locale) ?? when}
              </dd>
            </dl>
          )}
          {conflict && (
            <Button kind="two" size="s" onPress={mine} disabled={busy}>
              {t("edit.keepMine")}
            </Button>
          )}
          <Button kind="quiet" size="s" onPress={discard} disabled={busy}>
            {t(conflict ? "edit.keepTheirs" : "edit.discard")}
          </Button>
        </div>
      )}
    </>
  );
}

function editorKeys(
  event: KeyboardEvent<HTMLDivElement>,
  ready: boolean,
  cancelEdit: () => void,
  submit: () => void,
) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelEdit();
  }
  if (
    ready &&
    event.key === "Enter" &&
    event.target instanceof HTMLInputElement &&
    !event.altKey &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    submit();
  }
}

type EditQuestionsProps = Pick<
  ReturnType<typeof useEditLeave>,
  "scopeAsked" | "question" | "cancel" | "chooseScope" | "confirm"
> & {
  anchor: RefObject<HTMLDivElement | null>;
  scopeAnchor?: HTMLElement;
  draft: EventDraft;
  original: CalendarEventRecord;
  exception: CalendarEventRecord | null;
};

function EditQuestions({
  anchor,
  scopeAnchor,
  draft,
  original,
  exception,
  scopeAsked,
  question,
  cancel,
  chooseScope,
  confirm,
}: EditQuestionsProps) {
  const locale = useLocale();
  const t = useText("calendar");
  const invited = question?.invited ?? [];
  const inviting = invited.length > 0;
  const names = inviting ? invited : question?.names;
  const whom = guestNames(names ?? [], locale, t);
  const title = draft.title.trim();
  const scope = (id: Parameters<typeof chooseScope>[0], label: string, keyHint: string) => ({
    id,
    label: t(`edit.${label}`),
    keyHint,
    onPress: () => chooseScope(id),
  });
  return (
    <>
      {scopeAsked && (
        <QuestionBeforeAct
          open
          anchor={scopeAnchor ?? anchor}
          onClose={cancel}
          question={t("edit.changeSeries", { title })}
          follows={editScopeLine(
            repeatLine(original.repeat?.rules[0], original.start.value, t, locale),
            exception !== null,
            Number(exception?.recurrenceId) === Date.parse(original.startsAt),
            t,
          )}
          cancel={t("edit.cancel")}
          scopes={[
            // A changed rule cannot be one occurrence's; a removed rule leaves no following part.
            ...(draft.repeat === (original.repeat?.rules[0] ?? null)
              ? [scope("occurrence", "thisEvent", "1")]
              : []),
            ...(draft.repeat !== null ? [scope("following", "following", "2")] : []),
            scope("record", "allEvents", "3"),
          ]}
        />
      )}
      {question && (
        <QuestionBeforeAct
          open
          anchor={anchor}
          onClose={cancel}
          question={t(inviting ? "edit.confirmInvite" : "edit.tell", { guests: whom })}
          follows={inviting ? t("edit.inviteFollows", { title, when: draftWhen(draft, locale) }) : title}
          cancel={t("edit.cancel")}
          answers={[
            {
              id: "send",
              label: inviting ? t("edit.sendInvitation", { count: invited.length }) : t("edit.sendUpdate"),
              keyHint: "↵",
              onPress: confirm,
            },
          ]}
        />
      )}
    </>
  );
}

function usePreserveEdit(
  beforeRestore: RefObject<(() => void) | null>,
  changed: boolean,
  report: () => void,
) {
  useLayoutEffect(() => {
    beforeRestore.current = changed ? report : null;
    return () => {
      beforeRestore.current = null;
    };
  }, [beforeRestore, changed, report]);
}
