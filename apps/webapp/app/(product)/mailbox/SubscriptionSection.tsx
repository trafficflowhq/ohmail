"use client";

import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { SubscriptionPane, useSubscription } from "@ohmail/app/account";
import { useFrame } from "@ohmail/app/frame";
import { useStorage } from "@ohmail/app/account/storage";
import { mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { confirmedAccountForScope, panesOf } from "@ohmail/app/host";
import type { PaneSheet } from "@ohmail/app/settings";
import { TextFromIntl } from "../../shell/LocaleContext";
import { useSubscriptionDoor } from "./subscription-door";
import { useStorageDoor } from "./storage-door";
import { StepUp } from "./StepUp";

export { useManageOffer } from "./use-manage-offer";

type Props = { readonly onNowhere: () => void; readonly sheet?: PaneSheet };

/** The read uses the access answer already held for this frame. Only the Manage press asks for a link. */
export function MountedSubscriptionSection({ onNowhere, sheet }: Props) {
  const { host, commands } = useFrame();
  const owner = confirmedAccountForScope(host);
  const model = useSubscription(useSubscriptionDoor(owner, onNowhere));
  const mailboxes = liveMailboxes(useMailState().mailboxes);
  const storage = useStorage(useStorageDoor(mirrorOwnerOf(host.engine) ?? host.session.scope, owner));
  const offer = storage.figures?.plans;
  const mayChange = owner !== null && offer?.mayChange === true;
  const addon = mayChange && !offer.addon?.atLimit ? offer.addon : null;
  const mailboxAddon = mayChange ? offer.mailboxAddon : undefined;
  return (
    <SubscriptionPane
      model={storage.changing ? { ...model, opening: true } : model}
      sheet={sheet}
      connectedCount={mailboxes?.length ?? null}
      addStorage={addon ? {
        press: () => storage.change("storage"),
        busy: storage.changing,
        unit: addon.unit,
        price: addon.price,
      } : undefined}
      addMailbox={mailboxAddon ? { press: () => storage.change("mailbox"), busy: storage.changing, ...mailboxAddon } : undefined}
      change={addon || mailboxAddon ? {
        feedback: storage,
        factor: storage.ask === null ? null : <StepUp {...storage.ask} expectedOwner={owner} />,
      } : undefined}
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
