"use client";

import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { SubscriptionPane, useSubscription } from "@ohmail/app/account";
import { useFrame } from "@ohmail/app/frame";
import { confirmedAccountForScope, panesOf } from "@ohmail/app/host";
import { TextFromIntl } from "../../shell/LocaleContext";
import { useSubscriptionDoor } from "./subscription-door";

export { useManageOffer } from "./use-manage-offer";

type Props = { readonly onNowhere: () => void };

/** The read uses the access answer already held for this frame. Only the Manage press asks for a link. */
export function MountedSubscriptionSection({ onNowhere }: Props) {
  const { host, commands } = useFrame();
  const owner = confirmedAccountForScope(host);
  const model = useSubscription(useSubscriptionDoor(owner, onNowhere));
  const mailboxes = liveMailboxes(useMailState().mailboxes);
  return (
    <SubscriptionPane
      model={model}
      connectedCount={mailboxes?.length}
      toStorage={panesOf(host).storage ? () => commands.go({ place: "settings", sub: "storage" }) : null}
    />
  );
}

export function SubscriptionSection({ onNowhere }: Props) {
  const model = useSubscription(useSubscriptionDoor(null, onNowhere));
  return (
    <TextFromIntl>
      <SubscriptionPane model={model} toStorage={null} />
    </TextFromIntl>
  );
}
