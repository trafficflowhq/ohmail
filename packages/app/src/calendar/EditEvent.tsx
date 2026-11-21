import { useRef, useState } from "react";
import { type CalendarEventRecord, type CalendarPort, type CalendarRecord } from "@ohmail/app-logic/calendar";
import { Button, RefusalLine } from "@ohmail/ui/base";
import { EventCard, QuestionBeforeAct } from "@ohmail/ui/calendar";
import { useFrame } from "../frame/commands.js";
import { useEditLeave } from "./use-edit-leave.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";
import { DraftFields } from "./DraftFields.js";
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
}

export function EditEvent({ port, original, allowed, calendar, face, when, today }: Props) {
  const { commands, plan } = useFrame();
  const t = useText("calendar");
  const zone = useTimeZone();
  const locale = useLocale();
  const card = useRef<HTMLDivElement>(null);
  const [initial] = useState(() => draftOfRecord(original));
  const [draft, setDraft] = useState(initial.draft);
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
  } = useEditLeave(port, original, () => allowed()?.record ?? null, patch, face.ref.occurrence);
  const change = (edit: Partial<EventDraft>) => {
    setDraft((previous) => ({ ...previous, ...edit }));
    clear();
  };
  const sourceZone = original.start.kind === "instant" ? "UTC" : original.start.zone;
  const names = question?.names;
  const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  const whom = names
    ? list.format(
        names.length > 2 ? [...names.slice(0, 2), t("edit.others", { count: names.length - 2 })] : names,
      )
    : "";
  return (
    <>
      <EventCard
        ref={card}
        title={t("edit.event")}
        tone={face.tone}
        frame={plan.device === "phone" ? "sheet" : "card"}
        when={when}
        titleInput={{
          label: t("create.name"),
          value: draft.title,
          onChange: (title) => change({ title }),
          readOnly: busy,
        }}
        close={{ label: t("closeEvent"), onPress: () => commands.event(null) }}
        editor={
          <>
            <div inert={busy}>
              <DraftFields
                draft={draft}
                today={today}
                calendar={calendar}
                choices={[]}
                change={change}
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
      {scopeAsked && (
        <QuestionBeforeAct
          open
          anchor={card}
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
          anchor={card}
          onClose={cancel}
          question={t("edit.tell", { guests: whom })}
          follows={t("edit.tells", { title: draft.title.trim() })}
          cancel={t("edit.cancel")}
          answers={[{ id: "send", label: t("edit.sendUpdate"), keyHint: "↵", onPress: confirm }]}
        />
      )}
    </>
  );
}
