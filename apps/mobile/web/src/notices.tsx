/**
 * THE PAGE'S TWO USES OF THIS DEVICE'S NOTICE CHOICES, mounted once in the page, over the copy it draws from.
 *
 * The one caller of the phone's emitter: at each settle of that copy it asks the gate and hands the emitter what
 * the gate answered (`use-notices`). Nothing where the host hands in no emitter: the iPhone, the calendar's app.
 * The choices and the permission are read at each settle, so a switch pressed counts at once.
 *
 * The wake's teller: it tells native whether a closed app is to be woken for new mail (`wakeWanted`), from the
 * same choices through the same reader, so the registration follows the two switches. Both are here because both
 * read the choices at the same moments, and a second reader of them could disagree with the first.
 */
import {
  CALENDAR_NOTICES_KEY,
  NOTIFICATION_CHANNELS_KEY,
  useNoticesVersion,
} from "@ohmail/app-logic/notices/browser-channels";
import { useEffect, useMemo } from "react";
import { useDerivedVersion, useEngine, useSyncStatus } from "@ohmail/app-logic/engine";
import { noticeReadsOf, useNotices } from "@ohmail/app-logic/notices/use-notices";
import { NONE, type HostContract } from "@ohmail/app/host";
import { calendarChoicesOf, mailChoicesOf, noticeChoicesOf, type NoticeChoices } from "./engine-package";

/** A stored record as it was written, or null: absent, unreadable or no JSON all read as the start values. */
function stored(storage: Pick<Storage, "getItem">, name: string): unknown {
  try {
    const text = storage.getItem(name);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** Read the same records for the running notices and widgets. Older device-wide mail switches
 * carry forward, with previews off until this account sets its own choice. */
function storedChoices(storage: Pick<Storage, "getItem">, ohcalPhone: boolean, scope?: string) {
  const sharedMail = stored(storage, NOTIFICATION_CHANNELS_KEY);
  if (scope === undefined) return { mail: sharedMail, calendar: stored(storage, CALENDAR_NOTICES_KEY) };
  return {
    mail: stored(storage, `${NOTIFICATION_CHANNELS_KEY}.${scope}`) ??
      { ...mailChoicesOf(sharedMail, { ohcalPhone }), showMailDetails: false },
    calendar: stored(storage, `${CALENDAR_NOTICES_KEY}.${scope}`),
  };
}

export function storedNoticeChoices(storage: Pick<Storage, "getItem">, ohcalPhone: boolean, scope?: string): NoticeChoices {
  const { mail, calendar } = storedChoices(storage, ohcalPhone, scope);
  return noticeChoicesOf(mail, calendar, { ohcalPhone });
}

export function storedWidgetChoices(storage: Pick<Storage, "getItem">, scope?: string) {
  const where = { ohcalPhone: true };
  const { mail, calendar } = storedChoices(storage, where.ohcalPhone, scope);
  const choices = calendarChoicesOf(calendar, where);
  return { ...choices, cal_alert: mailChoicesOf(mail, where).master && choices.cal_alert };
}

/**
 * IS A CLOSED APP TO BE WOKEN FOR NEW MAIL? Only while this device's master switch and its new-mail switch are
 * both on: new mail is the one thing worth starting a closed app for, and with either off there is nothing a
 * wake could draw. The other switches bear on a running app alone.
 */
export function wakeWanted(choices: NoticeChoices): boolean {
  return choices.master === true && choices.ohbox === true;
}

/**
 * TELLS NATIVE WHETHER THE WAKE IS WANTED: once when the page first reads its choices, and again whenever the
 * answer changes. Native keeps this pairing's wake registration only while the answer is yes, and takes it down at
 * the server and at the distributor while it is no. `sync` is the host's own (the bridge's act); a surface that
 * has none says nothing. An answer native refused, or one lost with a page that was going away, is said again at
 * the next settle.
 */
export function wakeTeller(sync: ((wanted: boolean) => Promise<unknown>) | undefined): (choices: NoticeChoices) => void {
  let told: boolean | null = null;
  return (choices) => {
    const wanted = wakeWanted(choices);
    if (sync === undefined || wanted === told) return;
    told = wanted;
    void Promise.resolve().then(() => sync(wanted)).catch(() => {
      if (told === wanted) told = null;
    });
  };
}

export function PhoneNotices({ host, choices }: { readonly host: HostContract; readonly choices: () => NoticeChoices }) {
  const engine = useEngine();
  const version = useNoticesVersion(useDerivedVersion());
  const sync = useSyncStatus();
  const notifications = host.device.notifications;
  // The wake registration follows the two switches: read with the choices, at the first draw and at each change
  // of the copy, through the same reader the gate is handed.
  const tellWake = useMemo(
    () => wakeTeller(notifications === NONE || notifications.syncSubscription === undefined
      ? undefined : (wanted) => notifications.syncSubscription!(wanted)),
    [notifications],
  );
  useEffect(() => { tellWake(choices()); });
  const reads = useMemo(
    // The page draws no Devices list yet: nothing but a notice native posted counts as told here.
    () => noticeReadsOf(engine, notifications === NONE ? null : notifications, { choices, atDevices: () => false }),
    [choices, engine, notifications],
  );
  useNotices({
    reader: engine.read(),
    version,
    // Mid-catch-up a count is still moving, and is no event.
    settled: !sync.bootstrapping,
    scope: host.session.scope,
    emitter: notifications === NONE || notifications.emitter === NONE ? "none" : notifications.emitter,
    reads,
  });
  return null;
}
