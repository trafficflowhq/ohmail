import { useLayoutEffect, useRef, useState } from "react";
import { pressAndHear, type CalendarEventRecord, type CalendarPort } from "@ohmail/app-logic/calendar";
import type { CalendarChangeScope, CalendarEventFields } from "@ohmail/wire";
import { useFrame, useReport } from "../frame/commands.js";
import { fragmentOf } from "../frame/route.js";
import { eventUpdate, guestUpdate, type GuestUpdate } from "./guest-update.js";
import { useText } from "../text/index.js";

type Choice = "close" | "mine" | "theirs";

const needsConfirmation = (update: GuestUpdate, approved?: GuestUpdate) =>
  update.names.length > 0 &&
  (update.proposal !== approved?.proposal ||
    JSON.stringify(update.audience) !== JSON.stringify(approved.audience));

function useEventSave(
  port: CalendarPort,
  original: CalendarEventRecord,
  current: () => CalendarEventRecord | null,
  patch: Partial<CalendarEventFields> | null,
  occurrence: string | null,
) {
  const e = useText("event");
  const report = useReport();
  const [scopeChoice, askScope] = useState<{ choice: Choice; version: string } | null>(null);
  const [question, ask] = useState<{ choice: Choice; update: GuestUpdate } | null>(null);
  const [failure, fail] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const ticket = useRef<symbol | null>(null);
  const leave = useRef<(() => void) | null>(null);
  const refusedId = useRef<string | null>(null);
  const base = useRef(original.updatedAt);
  const save = async (
    choice: Choice,
    approved?: GuestUpdate,
    scope?: CalendarChangeScope,
    scopeVersion?: string,
  ) => {
    if (ticket.current || !leave.current || (conflict && choice === "close")) return;
    const record = current();
    if ((!record || !patch) && choice !== "theirs") {
      fail(e(record ? "refusal.invalid" : "refusal.readOnly"));
      return;
    }
    if (choice !== "theirs" && record?.repeat && (!scope || scopeVersion !== record.updatedAt)) {
      if (!occurrence) {
        fail(e("refusal.invalid"));
        return;
      }
      askScope({ choice, version: record.updatedAt });
      return;
    }
    askScope(null);
    if (choice !== "theirs" && patch && record) {
      const update = guestUpdate(record, patch);
      if (needsConfirmation(update, approved)) {
        ask({ choice, update });
        return;
      }
    }
    ask(null);
    const request = Symbol();
    ticket.current = request;
    setBusy(true);
    try {
      if (choice !== "close" && refusedId.current) {
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
        leave.current?.();
        return;
      }
      const latest = current();
      if (!latest || !patch || !!latest.repeat !== !!original.repeat) {
        fail(e("refusal.readOnly"));
        return;
      }
      if (latest.repeat && (!scope || scopeVersion !== latest.updatedAt)) {
        askScope({ choice, version: latest.updatedAt });
        return;
      }
      if (latest !== record) {
        const update = guestUpdate(latest, patch);
        if (needsConfirmation(update, approved)) {
          ask({ choice, update });
          return;
        }
      }
      if (choice === "mine") base.current = latest.updatedAt;
      const heard = await pressAndHear(
        port,
        eventUpdate(latest, base.current, patch, scope ?? { kind: "record" }),
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
      if (heard.say) report(e(heard.say));
      leave.current?.();
    } catch {
      if (ticket.current === request) fail(e("refusal.unknown"));
    } finally {
      if (ticket.current === request) {
        ticket.current = null;
        setBusy(false);
      }
    }
  };
  return { busy, failure, conflict, scopeChoice, askScope, question, ask, fail, ticket, leave, save };
}

export function useEditLeave(
  port: CalendarPort,
  original: CalendarEventRecord,
  current: () => CalendarEventRecord | null,
  patch: Partial<CalendarEventFields> | null,
  occurrence: string | null,
) {
  const { host, route, commands } = useFrame();
  const { busy, failure, conflict, scopeChoice, askScope, question, ask, fail, ticket, leave, save } =
    useEventSave(port, original, current, patch, occurrence);
  const intent = useRef<Choice | "discard">("close");
  const dirty = !patch || Object.keys(patch).length > 0;
  const held = dirty || conflict;
  const fragment = fragmentOf(route);
  const address = host.device.address;

  const submit = useRef(save);
  submit.current = save;
  useLayoutEffect(() => {
    if (!held) return;
    return address.holdLeave((resume) => {
      leave.current = resume;
      if (intent.current === "discard") resume();
      else void submit.current(intent.current);
    }, fragment);
  }, [address, held, fragment, leave]);
  useLayoutEffect(
    () => () => {
      ticket.current = null;
      leave.current = null;
    },
    [host.engine, port, leave, ticket],
  );
  const resolve = (choice: "mine" | "theirs" | "discard") => {
    if (leave.current) {
      if (choice === "discard") leave.current();
      else void save(choice);
    } else {
      // Cancel abandoned the old destination. This decision closes just the event.
      intent.current = choice;
      commands.event(null);
      intent.current = "close";
    }
  };
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
      const first = Number(occurrence) === Date.parse(current()?.startsAt ?? "");
      let scope: CalendarChangeScope = { kind: "record" };
      if (kind === "occurrence") scope = { kind, at: occurrence };
      if (kind === "following" && !first) scope = { kind, at: occurrence, newEventId: port.newId() };
      void save(scopeChoice.choice, undefined, scope, scopeChoice.version);
    },
    question: question?.update ?? null,
    cancel: () => {
      askScope(null);
      ask(null);
      leave.current = null;
    },
    confirm: () => {
      if (question) void save(question.choice, question.update);
    },
    mine: () => resolve("mine"),
    discard: () => resolve(conflict ? "theirs" : "discard"),
  };
}
