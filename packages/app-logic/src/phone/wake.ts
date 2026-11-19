/** The native wake outcome without a server registration identifier. */
export type WakeDisplayState =
  | { readonly k: "no_distributor" | "not_supported_here" | "server_has_no_key" | "on" }
  | { readonly k: "off"; readonly reason: string };

export type WakeSentenceKey =
  | "noDistributor"
  | "ios"
  | "desktopHost"
  | "noKey"
  | "on"
  | "refused"
  | "failed"
  | "rowRemains"
  | "switchedOff";

export interface WakePaneState {
  readonly os: "android" | "ios";
  readonly state: WakeDisplayState;
  readonly choices: readonly { readonly id: string; readonly name: string }[];
  readonly chosen: string | null;
  readonly busy: boolean;
}

export function wakeSentenceKey(state: WakeDisplayState, os: string): WakeSentenceKey {
  switch (state.k) {
    case "no_distributor":
      return os === "ios" ? "ios" : "noDistributor";
    case "not_supported_here":
      return "desktopHost";
    case "server_has_no_key":
      return "noKey";
    case "on":
      return "on";
    case "off":
      switch (state.reason) {
        case "row_remains":
          return "rowRemains";
        case "endpoint_refused":
          return "refused";
        case "switched_off":
          return "switchedOff";
        default:
          return "failed";
      }
  }
}
