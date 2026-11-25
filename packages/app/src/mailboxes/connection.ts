"use client";

import { createContext, createElement, useContext } from "react";
import { Notice } from "@ohmail/ui/base";
import { useConnectionNotice } from "../frame/connection.js";
import { useManagedService } from "@ohmail/app-logic/doors/managed-service";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { connectionReason } from "@ohmail/app-logic/mail-state/connection-reason";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useBrowserOnline } from "@ohmail/app-logic/session/browser-online";
import { routeOf, useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import { useLocale, useText, useTimeZone } from "../text/index.js";

/** The ladder's state, the network and the why, fed to the frame's connection slot. */
export function useMailConnectionReading() {
  const { host, commands } = useFrame();
  const t = useText("sync");
  const tm = useText("mailboxes");
  const managed = useManagedService();
  const online = useBrowserOnline();
  const { state: mail, freshness } = useMailState();
  const setupHref = useSetupHref();
  const locale = useLocale();
  const zone = useTimeZone();
  const firstRun = host.wires.firstRun;
  const follow = useStableCallback((href: string): void => {
    if (href.startsWith("#")) commands.go(routeOf(href));
    else if (firstRun !== NONE && href === firstRun.setupHref) firstRun.resume?.();
  });
  return {
    mail,
    online,
    setupHref,
    copyAsOf: freshness.asOf,
    follow,
    reason: connectionReason(mail, t, tm, managed, host.session.scope, { locale, zone }),
  };
}

/** The account's connection information belongs with the mailbox rows in Settings. */
export function MailConnectionDetails() {
  const { host, commands, route } = useFrame();
  const read = useMailConnectionReading();
  const details = useConnectionNotice(
    { ...read, host: null, session: host.session.state },
    {
      recover: host.session.recover,
      mailboxes: () =>
        commands.go({
          place: "settings",
          sub: "mailboxes",
          words: read.mail?.mailboxId ? { mailbox: read.mail.mailboxId } : {},
        }),
      help: () => commands.go({ place: "settings", sub: "help" }),
      follow: read.follow,
      ...(read.setupHref ? { connect: () => read.follow(read.setupHref!) } : {}),
    },
    read.reason,
    "mailboxes",
  );
  if (read.mail?.mailboxId && read.mail.mailboxId === route.words.mailbox) return null;
  return (
    details &&
    createElement(Notice, {
      ...details,
      place: "bar",
      progress: details.kind === "firstSync",
    })
  );
}

/** Where "connect a mailbox" goes, as the boot duties answered it. Provided by `MailBoot` alone. */
export const SetupHrefContext = createContext<string | null | undefined>(undefined);

/** The one reader of where "connect a mailbox" goes. Throws where no boot duties stand above. */
export function useSetupHref(): string | null {
  const href = useContext(SetupHrefContext);
  if (href === undefined) throw new Error("useSetupHref: no boot duties stand above (SetupHrefContext)");
  return href;
}
