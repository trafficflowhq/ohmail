import { NONE } from "../host/index.js";
import { useLayoutEffect } from "react";
import {
  pressAndHear,
  sentenceOf,
  type CalendarAct,
  type CalendarEventRecord,
  type CalendarPort,
  type CalendarVerdict,
} from "@ohmail/app-logic/calendar";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { useFrame, useReport } from "../frame/commands.js";
import type { Route } from "../frame/contract.js";
import type { HostAddress, None } from "../host/index.js";
import { fragmentOf } from "../frame/route.js";
import { useText } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

export type DraftWriteFailure = {
  reason: string;
  calendar: string;
  inviteesRefused: boolean;
  writeId?: string;
};

type Recovery = { draft: EventDraft } & (
  | { kind: "new"; calendar: string | null; failure?: DraftWriteFailure }
  | { kind: "edit"; original: CalendarEventRecord }
);
type Pending = { data: Recovery; port: CalendarPort; fragment: string; engine: object };

const pending = new WeakMap<HostAddress, Pending>();
const listeners = new WeakMap<HostAddress, () => void>();

export function useDiscardReport(port: CalendarPort) {
  const { commands, route, host } = useFrame();
  const t = useText("calendar");
  const report = useReport();
  const address = host.device.address;
  return (
    data: Recovery,
    notice?: { text: string; line?: string; action: string; beforeRestore?: () => void },
  ) => {
    const target: Route = route;
    const fragment = fragmentOf(target);
    const deadline = notice ? Number.MAX_SAFE_INTEGER : Date.now() + UNDO_MS;
    report(notice?.text ?? t("draft.discarded"), {
      action: notice?.action ?? t("draft.undo"),
      line: notice?.line,
      actionDeadline: deadline,
      retainUndo: true,
      actionUntilPressed: notice !== undefined,
      onAction: () => {
        if (Date.now() >= deadline) return;
        notice?.beforeRestore?.();
        const recovery = { data, port, fragment, engine: host.engine };
        pending.set(address, recovery);
        if (address.read() === fragment) listeners.get(address)?.();
        else commands.go(target, data.kind === "new" ? { history: "open-dialog" } : undefined);
        setTimeout(() => {
          if (pending.get(address) === recovery) pending.delete(address);
        }, UNDO_MS);
      },
    });
  };
}

export function useRefusedDraft(port: CalendarPort) {
  const recover = useDiscardReport(port);
  const t = useText("calendar");
  const e = useText("event");
  const report = useReport();
  return (
    data: Recovery,
    act: CalendarAct,
    verdict: CalendarVerdict,
    writeId?: string,
    keepCreate = false,
  ) => {
    const reason = e(sentenceOf(act, verdict) ?? "refusal.unknown");
    if (data.kind === "new" && data.calendar && keepCreate) {
      recover(
        {
          ...data,
          failure: {
            reason,
            calendar: data.calendar,
            inviteesRefused: verdict.kind === "refused" && verdict.word === "invitees_unsupported",
            writeId,
          },
        },
        {
          text: e("notSaved"),
          line: reason,
          action: t("draft.reopen"),
          beforeRestore:
            writeId === undefined && act.kind === "calendar_event_create"
              ? () => port.forgetUnsentCreate?.(act.eventId)
              : undefined,
        },
      );
      return;
    }
    recover(data, {
      text: reason,
      action: t("draft.reopen"),
      beforeRestore: writeId
        ? () => {
            void pressAndHear(port, { kind: "calendar_write_dismiss", writeId }).catch(() =>
              report(e("refusal.unknown")),
            );
          }
        : undefined,
    });
  };
}

export function useDraftRestore<K extends Recovery["kind"]>(
  kind: K,
  port: CalendarPort | None,
  restore: (data: Extract<Recovery, { kind: K }>) => void,
) {
  const { route, host } = useFrame();
  const address = host.device.address;
  const fragment = fragmentOf(route);
  useLayoutEffect(() => {
    const take = () => {
      const recovery = pending.get(address);
      if (
        recovery?.data.kind !== kind ||
        recovery.fragment !== fragment ||
        recovery.port !== port ||
        recovery.engine !== host.engine
      )
        return;
      pending.delete(address);
      restore(recovery.data as Extract<Recovery, { kind: K }>);
    };
    listeners.set(address, take);
    take();
    return () => {
      if (listeners.get(address) === take) listeners.delete(address);
    };
  });
}

/** Open an unsent copy or a failed creation through the account-bound draft restore seam. */
export function useOpenNewDraft(port: CalendarPort | typeof NONE) {
  const { commands, route, host } = useFrame();
  return (draft: EventDraft, calendar: string | null, failure?: DraftWriteFailure) => {
    if (port === NONE) return;
    const target: Route = {
      ...route,
      sub: draft.day,
      open: null,
      words: { panel: "new" },
    };
    const address = host.device.address;
    const data: Recovery = { kind: "new", draft, calendar, failure };
    const recovery = { data, port, fragment: fragmentOf(target), engine: host.engine };
    pending.set(address, recovery);
    commands.go(target, { history: "open-dialog" });
    setTimeout(() => {
      if (pending.get(address) === recovery) pending.delete(address);
    }, UNDO_MS);
  };
}
