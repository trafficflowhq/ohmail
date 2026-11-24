/** File the current stream card through the normal Move and sender-routing window. */
import { useMemo, type RefObject } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { usePartition } from "../consent/partition.js";
import { useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { pressMove } from "../press/message-verbs.js";
import { rulesPostureOf } from "../press/rules-posture.js";
import { useStableCallback } from "../press/stable-callback.js";
import { planRules, type MoveContext } from "../press/verb-context.js";
import type { ListMove } from "../reading/list-meeting.js";
import { useNowAt } from "../session/day-clock.js";
import type { Translator } from "../text/translator.js";

export function useStreamMove(
  args: PlaceLiveArgs,
  items: readonly EngineMessage[],
  toolbar: RefObject<string | null>,
  t: Translator,
): ListMove {
  const engine = useEngine();
  const { ownAddresses } = usePartition();
  const { mailboxes } = useMailState();
  const nowAt = useNowAt();
  const rulesTravel = useMemo(() => rulesPostureOf(mailboxes).mode === "pending", [mailboxes]);
  const surfaceById = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const cx: MoveContext = {
    engine,
    press: args.press,
    rulesTravel,
    t,
    toast: args.report,
    nowAt,
    ownAddresses,
    surfaceById,
    offOhbox: true,
  };
  args.press.routing.planOver.current = rulesTravel ? (read) => planRules(cx, read) : null;
  return useStableCallback((message, place) => {
    const current = surfaceById.get(message.id);
    if (current && toolbar.current === current.id) pressMove(cx, place, current, "letter");
  });
}
