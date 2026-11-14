"use client";

/**
 * THE ONE CALLER OF THIS SURFACE'S SYSTEM NOTICES: new mail, a sender waiting in the Screener, a scheduled letter
 * sent or not sent, a device paired or signed out. At each settle of the copy the lists show, the gate is asked what
 * may be drawn and the host's emitter is handed each answer (`useNotices`); an account switch takes back what was
 * drawn for the account left. A headless feeder of the ground: it draws no node, and it stands once per frame, so
 * one caller stands per surface. Moved from the old shell, which was the caller on the web and the desktop.
 *
 * WHAT IT READS, and whose: the mirror as the lists present it (a notice's number and the rail's never disagree);
 * settled as the Ohbox's count is (the mail state's, and the Screener's own store); the frame's scope; and of the
 * host's notifications its emitter, its permission and THE PERSON'S STORED CHOICES (`choices`), which a shell reads
 * from its own store at each settle. A host that hands no notifications, no emitter or no choices has nothing
 * drawn: the gate is never asked on a guess of what the person chose.
 *
 * The device counts come from the engine. A focused Devices pane can acknowledge the counts its list actually showed.
 */
import { useMemo } from "react";
import { useHostCalendarNotices } from "@ohmail/app-logic/calendar/alerts";
import { usePartition } from "@ohmail/app-logic/consent";
import { useDerivedVersion } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { noticeReadsOf, useNotices } from "@ohmail/app-logic/notices/use-notices";
import { usePresented } from "@ohmail/app-logic/reading";
import { useFrameElement } from "../../frame/FrameRoot.js";
import { useFrame, useSignal } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useScreener } from "../../screener/contract.js";

const QUIET_VERSION = { read: () => 0, subscribe: () => () => undefined };

export function MailSystemNotices(): null {
  const { host, route } = useFrame();
  const frame = useFrameElement();
  const reader = usePresented();
  const version = useDerivedVersion();
  const { mailboxes, state } = useMailState();
  const { ownAddresses } = usePartition();
  const storeSettled = useScreener().storeSettled;
  const notifications = host.device.notifications;
  const choices = notifications === NONE ? undefined : notifications.choices;
  const emitter = notifications === NONE || choices === undefined ? NONE : notifications.emitter;
  const choicesVersion = useSignal(
    notifications === NONE ? QUIET_VERSION : (notifications.choicesVersion ?? QUIET_VERSION),
  );
  const port = host.wires.calendar;
  const calendarVersion = useSignal(
    port === NONE ? QUIET_VERSION : { read: port.version, subscribe: port.subscribe },
  );
  const calendar = useHostCalendarNotices(
    host,
    mailboxes === null && ownAddresses.length === 0 ? null : ownAddresses,
    () => choices?.().showTitles === true,
    emitter === NONE ? [] : emitter.acts,
  );
  const devicesShown = route.place === "settings" && route.sub === "devices" && route.stage === null;
  const reads = useMemo(
    () =>
      noticeReadsOf(host.engine, notifications === NONE ? null : notifications, {
        choices: () => {
          if (choices === undefined)
            throw new Error("the notices' gate was asked over a host that stores no choices");
          return choices();
        },
        atDevices: () => devicesShown && frame?.current?.ownerDocument.hasFocus() === true,
        calendar,
      }),
    [host.engine, notifications, choices, devicesShown, frame, calendar],
  );
  useNotices({
    reader,
    version: version + choicesVersion + calendarVersion,
    settled: state.settled && storeSettled,
    scope: host.session.scope,
    emitter,
    reads,
  });
  return null;
}
