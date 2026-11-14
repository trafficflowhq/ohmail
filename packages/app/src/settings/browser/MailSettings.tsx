"use client";

import { useContext, type ReactNode } from "react";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { MailRichEditor } from "../../mail/index.js";
import { useConsent } from "@ohmail/app-logic/consent";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { FoldersPane, foldersMailboxes, pullAfter } from "../folders/index.js";
import { NotificationsPane } from "../notifications/index.js";
import { NotificationsContext } from "../notifications/summary.js";
import {
  SignatureEditor,
  SignaturesPane,
  useSignaturesModel,
  type SignatureEditorProps,
} from "../signatures/index.js";
import { standingNote } from "@ohmail/app-logic/consent/travelled-change";
import { TravelledChangeLine } from "./TravelledChangeLine.js";
import { useText } from "../../text/index.js";
import { useNotificationSettings, type NotificationPreferences } from "./use-notification-settings.js";

export function BrowserFoldersPane() {
  const { host } = useFrame();
  const consent = useConsent();
  const { mailboxes } = useMailState();
  const pull = () => host.engine.syncOnce();
  const model = {
    on: consent.foldersEnabled,
    set: pullAfter(consent.setFoldersEnabled, pull),
    mailboxes: foldersMailboxes({
      on: consent.foldersEnabled,
      known: consent.folderMailboxesKnown,
      settable: host.wires.consent !== NONE,
      mailboxes: liveMailboxes(mailboxes),
      off: consent.folderMailboxesOff,
    }),
    setMailbox: pullAfter(consent.setMailboxFoldersEnabled, pull),
  };
  return <FoldersPane model={model} />;
}

/** Reconcile the stored wake preference once on entry to Settings, including visits to General. */
export function BrowserSettingsAbove({
  children,
  preferences,
}: {
  readonly children: ReactNode;
  preferences: NotificationPreferences;
}) {
  const { host, route } = useFrame();
  const model = useNotificationSettings(
    host.device.notifications,
    host.session.scope,
    route.sub === "notifications",
    preferences,
  );
  return <NotificationsContext.Provider value={model}>{children}</NotificationsContext.Provider>;
}

export function BrowserNotificationsPane() {
  const model = useContext(NotificationsContext);
  return model && <NotificationsPane model={model} />;
}

function signatureEditor(props: SignatureEditorProps) {
  return <SignatureEditor {...props} editor={MailRichEditor} />;
}

export function BrowserSignaturesPane() {
  const t = useText("settings");
  const model = useSignaturesModel({
    editor: signatureEditor,
    changeNote: (change) => <TravelledChangeLine note={standingNote(change)} t={t} />,
  });
  return model ? <SignaturesPane model={model} /> : null;
}
