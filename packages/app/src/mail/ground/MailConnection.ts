"use client";

/**
 * THE CONNECTION, FED FOR THE FRAME'S LIFE: the mail state ladder's reading, the browser's own network, when the copy
 * on screen last finished a sync, where a person with no mailbox connects one, and why, in the sentences the sync strip
 * always said (`connectionReason`). The frame says it in its one slot (`useConnectionFeed`). A headless feeder of the
 * ground: it draws no node. Moved from the web shell's feed (`todays-reasons.ts`, `useTodaysConnection`).
 *
 * WHERE ITS WORDS LEAD: an address of the app (a mailbox's place in Settings) is gone to by the frame's own command;
 * the one address outside the app, the host's setup page, is left for by the host's own way there (the first run's
 * `resume`). A package names no address and opens no window.
 */
import { createElement } from "react";
import { Notice } from "@ohmail/ui/base";
import { useConnectionNotice } from "../../frame/connection.js";
import { useManagedService } from "@ohmail/app-logic/doors/managed-service";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { connectionReason } from "@ohmail/app-logic/mail-state/connection-reason";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { useBrowserOnline } from "@ohmail/app-logic/session/browser-online";
import { routeOf, useConnectionFeed, useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { useSetupHref } from "./boot-setup.js";

/** The ladder's state, the network and the why, fed to the frame's connection slot. */
function useMailConnectionReading() {
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

/** The connection's feeder, standing in the ground for the frame's life. */
export function MailConnection(): null {
  const { route } = useFrame();
  const read = useMailConnectionReading();
  const open = route.place === "settings" && route.sub === "mailboxes" && route.words.mailbox;
  useConnectionFeed(open && open === read.mail?.mailboxId ? { ...read, mail: null } : read);
  return null;
}
