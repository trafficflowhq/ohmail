import { useMailboxFacts } from "@ohmail/app-logic/mail-state";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import type { ScreenerLearner } from "./model.js";

export function useScreenerLearningSettings(): ScreenerLearner | null {
  const { host } = useFrame();
  const mailboxes = useMailboxFacts();
  const demo = useDemoMode();
  const wire = host.wires.screening;
  if (demo || wire === NONE || !wire.readLearning || !wire.changeLearning) return null;
  return {
    read: wire.readLearning,
    change: wire.changeLearning,
    metered: host.capabilities.service === "managed",
    mailboxes: (mailboxes ?? []).map((mailbox) => ({ id: mailbox.id, label: mailbox.address })),
  };
}
