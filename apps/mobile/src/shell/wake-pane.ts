import type { WakePaneState } from "@ohmail/app-logic/phone/wake";
import type { WakeSession } from "../net/push";
import type { Wake } from "../state/wake";
import type { Requests, WakePaneRequest } from "./bridge-kinds";

type WakeAnswer = Requests["phone.wake"]["answer"] | { readonly refused: "foreignScope" | "notReady" };

export function wakePaneState(wake: Wake, os: WakePaneState["os"]): WakePaneState {
  const choices = os === "ios" ? [] : wake.choices.map(({ id, name }) => ({ id, name }));
  const chosen = choices.some(({ id }) => id === wake.chosen) ? wake.chosen : null;
  const state =
    os === "android" && chosen === null && wake.state.k === "on" ? { k: "no_distributor" as const } : wake.state;
  const reason = state.k === "off" ? state.reason : "";
  const knownReason = reason === "row_remains" || reason === "endpoint_refused" || reason === "switched_off";
  return {
    os,
    state: state.k === "off" ? { k: "off", reason: knownReason ? reason : "failed" } : { k: state.k },
    choices,
    chosen,
    busy: wake.busy,
  };
}

export function answerWakePane(
  request: WakePaneRequest,
  wake: Wake,
  live: WakeSession | null,
  os: WakePaneState["os"],
): WakeAnswer {
  if (live === null || wake.session !== live) return { refused: "foreignScope" };
  if (request.do === "read") {
    const device = os === "ios" ? wake : { ...wake, ...wake.readDevice() };
    return { wake: wakePaneState(device, os) };
  }
  if (os === "ios" || wake.busy || wake.choices.length === 0) return { refused: "notReady" };
  if (request.do === "choose") {
    if (!wake.choices.some(({ id }) => id === request.distributor) || !wake.choose(request.distributor)) {
      return { refused: "notReady" };
    }
  } else {
    wake.turnOff();
  }
  return {};
}
