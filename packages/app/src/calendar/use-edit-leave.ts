import { useLayoutEffect, useRef, useState } from "react";
import { pressAndHear, type CalendarEventRecord, type CalendarPort } from "@ohmail/app-logic/calendar";
import type { CalendarChangeScope, CalendarEventFields } from "@ohmail/wire";
import { useFrame, useReport } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { editGuestUpdate, eventUpdate, type GuestUpdate } from "./guest-update.js";
import { reportCalendarUpdate, useSentUpdateLabel } from "./update-report.js";
import { useText } from "../text/index.js";
import { patchOnScope } from "./edit-draft.js";
import { editBase, editSchedule, editVersions, type EditableEvent } from "./editable-event.js";

type Choice = "save" | "mine" | "theirs";
type Consent = {
  readonly choice: Choice;
  readonly update: GuestUpdate;
  readonly scope?: CalendarChangeScope;
  readonly scopeVersion?: string;
};

const needsConfirmation = (update: GuestUpdate, approved?: GuestUpdate) =>
  update.names.length > 0 &&
  (update.proposal !== approved?.proposal ||
    JSON.stringify(update.audience) !== JSON.stringify(approved.audience));

function useEditQuestions(
  occurrence: string | null,
  fail: (message: string) => void,
  schedule: string | null,
) {
  const e = useText("event");
  const [scopeChoice, askScope] = useState<{ choice: Choice; version: string } | null>(null);
  const [question, ask] = useState<Consent | null>(null);
  const clear = () => {
    askScope(null);
    ask(null);
  };
  const review = (
    current: EditableEvent,
    change: Partial<CalendarEventFields>,
    choice: Choice,
    approved?: GuestUpdate,
    scope?: CalendarChangeScope,
    scopeVersion?: string,
  ) => {
    if (schedule !== null && (change.start || change.end) && editSchedule(current) !== schedule) {
      clear();
      fail(e("refusal.changed"));
      return false;
    }
    const version = editVersions(current);
    if (current.record.repeat && (!scope || scopeVersion !== version)) {
      if (!occurrence) fail(e("refusal.invalid"));
      else {
        ask(null);
        askScope({ choice, version });
      }
      return false;
    }
    askScope(null);
    const update = editGuestUpdate(current, change, scope);
    if (needsConfirmation(update, approved)) {
      ask({ choice, update, scope, scopeVersion });
      return false;
    }
    ask(null);
    return true;
  };
  return { scopeChoice, question, clear, review };
}

function useEventSave(
  port: CalendarPort,
  original: CalendarEventRecord,
  shown: CalendarEventRecord,
  current: () => EditableEvent | null,
  patch: Partial<CalendarEventFields> | null,
  occurrence: string | null,
  finish: () => void,
) {
  const e = useText("event");
  const report = useReport();
  const sentLabel = useSentUpdateLabel();
  const [failure, fail] = useState<string | null>(null);
  const initial = { record: original, exception: shown.recurrenceId ? shown : null };
  const questions = useEditQuestions(occurrence, fail, original.repeat ? editSchedule(initial) : null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const ticket = useRef<symbol | null>(null);
  const refusedId = useRef<string | null>(null);
  const base = useRef(original.updatedAt);
  const shownException = initial.exception?.id;
  const save = async (
    choice: Choice,
    approved?: GuestUpdate,
    scope?: CalendarChangeScope,
    scopeVersion?: string,
  ) => {
    if (ticket.current || (conflict && choice === "save")) return;
    const selected = current();
    const change = patch && patchOnScope(patch, scope, original, shown);
    if (choice === "theirs") questions.clear();
    else {
      if (!selected || !change || selected.exception?.id !== shownException) {
        fail(e(selected ? "refusal.invalid" : "refusal.readOnly"));
        return;
      }
      if (!questions.review(selected, change, choice, approved, scope, scopeVersion)) return;
    }
    const request = Symbol();
    ticket.current = request;
    setBusy(true);
    try {
      if (choice !== "save" && refusedId.current) {
        const dropped = await pressAndHear(port, {
          kind: "calendar_write_dismiss",
          writeId: refusedId.current,
        });
        if (ticket.current !== request) return;
        if (dropped.verdict?.kind === "refused") {
          fail(e(dropped.say!));
          return;
        }
        refusedId.current = null;
      }
      if (choice === "theirs") {
        finish();
        return;
      }
      const latest = current();
      if (
        !latest ||
        !change ||
        latest.exception?.id !== shownException ||
        !!latest.record.repeat !== !!original.repeat
      ) {
        fail(e("refusal.readOnly"));
        return;
      }
      if (!questions.review(latest, change, choice, approved, scope, scopeVersion)) return;
      const update = editGuestUpdate(latest, change, scope);
      if (choice === "mine") base.current = latest.record.updatedAt;
      const target = latest.exception ?? latest.record;
      const before = { ...latest.record };
      const heard = await pressAndHear(
        port,
        eventUpdate(
          target,
          scopeVersion ? editBase(latest, scope) : base.current,
          change,
          scope ?? { kind: "record" },
          update,
        ),
      );
      if (ticket.current !== request) return;
      if (heard.verdict?.kind === "refused") {
        if (heard.verdict.word === "version_stale") {
          const details = heard.verdict.details;
          refusedId.current =
            details && typeof details === "object" && "id" in details && typeof details.id === "string"
              ? details.id
              : null;
          setConflict(true);
        }
        fail(e(heard.say!));
        return;
      }
      if (heard.say) {
        const sent = heard.verdict?.kind === "taken" ? sentLabel(before, change, update) : undefined;
        reportCalendarUpdate(
          report,
          sent ?? e(heard.say),
          port,
          before,
          change,
          () => current()?.record ?? null,
          e,
        );
      }
      finish();
    } catch {
      if (ticket.current === request) fail(e("refusal.unknown"));
    } finally {
      if (ticket.current === request) {
        ticket.current = null;
        setBusy(false);
      }
    }
  };
  return { busy, failure, conflict, ...questions, fail, ticket, save };
}

export function useEditLeave(
  port: CalendarPort,
  original: CalendarEventRecord,
  shown: CalendarEventRecord,
  current: () => EditableEvent | null,
  patch: Partial<CalendarEventFields> | null,
  occurrence: string | null,
  dirty: boolean,
  finish: () => void,
  onLeave: () => void,
) {
  const { host, route } = useFrame();
  const { busy, failure, conflict, scopeChoice, question, clear, fail, ticket, save } = useEventSave(
    port,
    original,
    shown,
    current,
    patch,
    occurrence,
    finish,
  );
  const held = dirty || conflict || busy;
  const fragment = fragmentOf(route);
  const address = host.device.address;
  const departure = useRef(onLeave);
  departure.current = onLeave;
  useLayoutEffect(() => {
    if (!held) return;
    return address.holdLeave((resume) => {
      if (ticket.current) return;
      departure.current();
      resume();
    }, fragment);
  }, [address, held, fragment, ticket]);
  useLayoutEffect(
    () => () => {
      ticket.current = null;
    },
    [host.engine, port, ticket],
  );
  return {
    busy,
    failure,
    conflict,
    clear: () => {
      if (!conflict) fail(null);
    },
    scopeAsked: scopeChoice !== null,
    chooseScope: (kind: CalendarChangeScope["kind"]) => {
      if (!scopeChoice || !occurrence) return;
      const first = Number(occurrence) === Date.parse(current()?.record.startsAt ?? "");
      let scope: CalendarChangeScope = { kind: "record" };
      if (kind === "occurrence") scope = { kind, at: occurrence };
      if (kind === "following" && !first) scope = { kind, at: occurrence, newEventId: port.newId() };
      void save(scopeChoice.choice, undefined, scope, scopeChoice.version);
    },
    question: question?.update ?? null,
    cancel: clear,
    confirm: () => {
      if (question) void save(question.choice, question.update, question.scope, question.scopeVersion);
    },
    mine: () => void save("mine"),
    discard: conflict ? () => void save("theirs") : finish,
    submit: () => {
      if (patch && Object.keys(patch).length) void save("save");
    },
  };
}
