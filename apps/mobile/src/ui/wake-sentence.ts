/**
 * The one sentence Settings → New mail renders, chosen from the wake state and the platform.
 *
 * Pure, so a test can assert every state has a sentence and none claims a wake this build cannot
 * deliver. A `switch` over the union, so a new {@link WakeState} fails to compile here rather than
 * rendering nothing. iOS has no distributor to choose, so its sentence names none.
 */
import { wakeSentenceKey } from "@ohmail/app-logic/phone/wake";
import { Copy } from "../copy";
import type { WakeState } from "../net/push";

export function wakeSentence(state: WakeState, os: string): string {
  switch (wakeSentenceKey(state, os)) {
    case "noDistributor": return Copy.wakeNoDistributor;
    case "ios": return Copy.wakeNoPushIos;
    case "desktopHost": return Copy.wakeDesktopHost;
    case "noKey": return Copy.wakeServerNoKey;
    case "on": return Copy.wakeOn;
    case "rowRemains": return Copy.wakeRowRemains;
    case "refused": return Copy.wakeOff("endpoint_refused");
    case "switchedOff": return Copy.wakeOff("switched_off");
    case "failed": return Copy.wakeOff("failed");
  }
}
