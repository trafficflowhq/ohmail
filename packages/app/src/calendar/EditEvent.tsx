import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { type CalendarEventRecord, type CalendarPort, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { Button, RefusalLine } from "@ohmail/ui/base";
import { EventCard, QuestionBeforeAct } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import type { CardPlacement } from "./use-event-placement.js";
import { useEditLeave } from "./use-edit-leave.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { DraftFields } from "./DraftFields.js";
import { useDiscardReport } from "./draft-undo.js";
import { draftOfRecord, eventChanges } from "./edit-draft.js";
import type { EventDraft } from "./event-draft.js";
import type { CalendarEventFace } from "./faces.js";

interface Props {
  readonly port: CalendarPort;
  readonly original: CalendarEventRecord;
  readonly allowed: () => { record: CalendarEventRecord; calendar: CalendarRecord } | null;
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
  original,
  allowed,
  calendar,
  face,
  when,
  today,
  recovered,
  beforeRestore,
  card,
  placement,
  finish,
}: Props) {
  const { commands, plan } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const [initial] = useState(() => draftOfRecord(original));
  const [draft, setDraft] = useState(recovered ?? initial.draft);
  const discardReport = useDiscardReport(port);
  const dirty = draftDiffers(draft, initial.draft);
  const reportDraft = () => discardReport({ kind: "edit", draft, original });
  const onLeave = () => {
    if (dirty) reportDraft();
  };
  usePreserveEdit(beforeRestore, draftDiffers(draft, recovered ?? initial.draft), reportDraft);
  const patch = eventChanges(original, draft, calendar, zone);
  const {
    busy,
    failure,
    conflict,
    clear,
    mine,
    discard,
    question,
    confirm,
    cancel,
    chooseScope,
    scopeAsked,
    submit,
  } = useEditLeave(
    port,
    original,
    () => allowed()?.record ?? null,
    patch,
    face.ref.occurrence,
    dirty,
    finish,
    onLeave,
  );
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
  return (
    <>
      <EventCard
        ref={card}
        {...placement}
        title={t("edit.event")}
        tone={face.tone}
        frame={plan.device === "phone" ? "sheet" : "card"}
        titleInput={{
          label: t("create.name"),
          value: draft.title,
          onChange: (title) => change({ title }),
          readOnly: blocked,
        }}
        close={{ label: t("closeEvent"), onPress: () => commands.event(null) }}
        onKeyDown={(event) => editorKeys(event, ready, cancelEdit, submit)}
        editor={
          <>
            <div inert={blocked}>
              <DraftFields
                draft={draft}
                today={today}
                calendar={calendar}
                tone={face.tone}
                choices={[]}
                change={change}
                cancel={{ label: t("edit.cancel"), onPress: cancelEdit }}
                submit={{ label: t("edit.save"), keyHint: "↵", disabled: !ready, onPress: submit }}
                {...(!initial.timeEditable || original.repeat ? { fixedTime: when } : {})}
                {...(sourceZone ? { timeZone: sourceZone } : {})}
              />
            </div>
            {failure ? (
              <>
                <RefusalLine>{failure}</RefusalLine>
                {conflict && (
                  <Button kind="two" size="s" onPress={mine} disabled={busy}>
                    {t("edit.keepMine")}
                  </Button>
                )}
                <Button kind="quiet" size="s" onPress={discard} disabled={busy}>
                  {t(conflict ? "edit.keepTheirs" : "edit.discard")}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <EditQuestions
        anchor={card}
        title={draft.title}
        {...{ scopeAsked, question, cancel, chooseScope, confirm }}
      />
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
> & { anchor: RefObject<HTMLDivElement | null>; title: string };

function EditQuestions({
  anchor,
  title,
  scopeAsked,
  question,
  cancel,
  chooseScope,
  confirm,
}: EditQuestionsProps) {
  const locale = useLocale();
  const t = useText("calendar");
  const names = question?.names;
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const whom = names
    ? list.format(
        names.length > 2 ? [...names.slice(0, 2), t("edit.others", { count: names.length - 2 })] : names,
      )
    : "";
  return (
    <>
      {scopeAsked && (
        <QuestionBeforeAct
          open
          anchor={anchor}
          onClose={cancel}
          question={t("edit.whichEvents")}
          cancel={t("edit.cancel")}
          scopes={[
            {
              id: "occurrence",
              label: t("edit.thisEvent"),
              keyHint: "1",
              onPress: () => chooseScope("occurrence"),
            },
            {
              id: "following",
              label: t("edit.following"),
              keyHint: "2",
              onPress: () => chooseScope("following"),
            },
            { id: "record", label: t("edit.allEvents"), keyHint: "3", onPress: () => chooseScope("record") },
          ]}
        />
      )}
      {question && (
        <QuestionBeforeAct
          open
          anchor={anchor}
          onClose={cancel}
          question={t("edit.tell", { guests: whom })}
          follows={t("edit.tells", { title: title.trim() })}
          cancel={t("edit.cancel")}
          answers={[{ id: "send", label: t("edit.sendUpdate"), keyHint: "↵", onPress: confirm }]}
        />
      )}
    </>
  );
}

function draftDiffers(draft: EventDraft, baseline: EventDraft): boolean {
  return (Object.keys(draft) as (keyof EventDraft)[]).some((key) => draft[key] !== baseline[key]);
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
