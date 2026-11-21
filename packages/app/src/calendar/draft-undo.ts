import { useLayoutEffect } from "react";
import type { CalendarEventRecord, CalendarPort } from "@ohmail/app-logic/calendar";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { useFrame, useReport } from "../frame/commands.js";
import type { Route } from "../frame/contract.js";
import type { HostAddress, None } from "../host/index.js";
import { fragmentOf } from "../frame/route.js";
import { useText } from "../text/index.js";
import type { EventDraft } from "./event-draft.js";

type Recovery = { draft: EventDraft } & (
  { kind: "new"; calendar: string | null } | { kind: "edit"; original: CalendarEventRecord }
);
type Pending = { data: Recovery; port: CalendarPort; fragment: string; engine: object };

const pending = new WeakMap<HostAddress, Pending>();
const listeners = new WeakMap<HostAddress, () => void>();

export function useDiscardReport(port: CalendarPort) {
  const { commands, route, host } = useFrame();
  const t = useText("calendar");
  const report = useReport();
  const address = host.device.address;
  return (data: Recovery) => {
    const target: Route = route;
    const fragment = fragmentOf(target);
    const deadline = Date.now() + UNDO_MS;
    report(t("draft.discarded"), {
      action: t("draft.undo"),
      actionDeadline: deadline,
      retainUndo: true,
      onAction: () => {
        if (Date.now() >= deadline) return;
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

/** Open a new, unsent copy. The same draft restore seam keeps the transfer within this account and port. */
export function useDuplicateDraft(port: CalendarPort) {
  const { commands, route, host } = useFrame();
  return (draft: EventDraft, calendar: string) => {
    const target: Route = {
      ...route,
      sub: draft.day,
      open: null,
      words: { panel: "new" },
    };
    const address = host.device.address;
    const data: Recovery = { kind: "new", draft, calendar };
    const recovery = { data, port, fragment: fragmentOf(target), engine: host.engine };
    pending.set(address, recovery);
    commands.go(target, { history: "open-dialog" });
    setTimeout(() => {
      if (pending.get(address) === recovery) pending.delete(address);
    }, UNDO_MS);
  };
}
