import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import {
  isoOfDay, nowIn, readerZones,
  type CalendarConnectionRecord, type CalendarPort, type CalendarRecord, type CalendarSettingsWire,
} from "@ohmail/app-logic/calendar";
import { addFound, foundOf, targetCalendarOf, type CalendarSuggestionRecord, type FoundRow } from "@ohmail/app-logic/calendar/found";
import { Copy } from "../copy";
import { activeLocale } from "../i18n/locale";
import { readerZone, type WorldMail } from "../state/live";
import { mailEventPort } from "../state/mail-event-port";
import { useLiveSession } from "../state/world";
import { mailColors } from "../theme/mail";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";
import { Icon } from "./Icon";

type Letter = Pick<WorldMail, "id" | "mailboxId" | "protected">;
const none = () => undefined;
const zero = () => 0;

/** Only the web's offered evidence for the currently signed-in mailbox can produce a card. */
export function useMailFoundEvents(letter: Letter | null | undefined, enabled = true) {
  const session = useLiveSession();
  const port = enabled && letter && !letter.protected ? mailEventPort(session) : null;
  const engine = port ? session?.engine : undefined;
  const subscribe = useCallback((change: () => void) => port?.subscribe(change) ?? none, [port]);
  const version = useSyncExternalStore(subscribe, port?.version ?? zero, zero);
  const zone = readerZone();
  const zones = readerZones();
  const now = nowIn(Date.now(), zone, zones);
  const today = now === null ? null : isoOfDay(now.day);
  const id = letter?.id;
  const mailbox = letter?.mailboxId;
  const found = useMemo(() => {
    if (!port || !engine || !today || id === undefined || mailbox === undefined) return null;
    const read = engine.read();
    const suggestions = read.list<CalendarSuggestionRecord>("calendar_suggestion")
      .filter((s) => s.messageId === id && s.mailboxId === mailbox);
    if (suggestions.length === 0) return null;
    const calendars = read.list<CalendarRecord>("calendar");
    const connections = new Map(read.list<CalendarConnectionRecord>("calendar_connection").map((c) => [c.id, c]));
    return {
      rows: foundOf({ suggestions, events: port.events(), calendars, todayKey: today, zone, zones }),
      calendars, connections,
    };
  }, [port, engine, today, id, mailbox, zone, zones, version]);
  const [preferred, setPreferred] = useState<{ port: CalendarPort; value: CalendarSettingsWire["newEventsCalendarId"] } | null>(null);
  const hasOffers = (found?.rows.length ?? 0) > 0;
  useEffect(() => {
    if (!port || !hasOffers) return;
    let live = true;
    void port.settings().then((settings) => {
      if (live) setPreferred({ port, value: settings.newEventsCalendarId });
    }, none);
    return () => { live = false; };
  }, [port, hasOffers]);
  if (!port || !found) return null;
  return {
    port, version,
    rows: found.rows,
    target: targetCalendarOf(found.calendars, found.connections, preferred?.port === port ? preferred.value : null),
  };
}

const pendingByPort = new WeakMap<CalendarPort, Map<string, { key?: string }>>();

export function MailFoundEvents({ found }: { found: ReturnType<typeof useMailFoundEvents> }) {
  if (!found || found.rows.length === 0) return null;
  return (
    <View style={{ gap: 8, marginBottom: 10 }}>
      {found.rows.map((row) => <FoundCard key={row.id} row={row} target={found.target?.id ?? null} port={found.port} version={found.version} />)}
    </View>
  );
}

type FoundStatus = "busy" | "failed" | "added" | "queued" | "dismissed" | null;

function FoundCard({ row, target, port, version }: { row: FoundRow; target: string | null; port: CalendarPort; version: number }) {
  const t = useTheme();
  const [status, setStatus] = useState<FoundStatus>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const pending = pendingByPort.get(port);
    const key = pending?.get(row.id)?.key;
    if (!key) return;
    const verdict = port.verdict(key);
    if (verdict?.kind === "refused") {
      pending?.delete(row.id);
      setStatus("failed");
    } else if (verdict?.kind === "taken") {
      setStatus("added");
    }
    if (row.alreadyOn) pending?.delete(row.id);
  }, [port, row.id, row.alreadyOn, version, status]);
  if (status === "dismissed") return null;
  const take = async (act: "add" | "dismiss") => {
    const pending = pendingByPort.get(port) ?? new Map<string, { key?: string }>();
    if (pending.has(row.id)) return;
    pendingByPort.set(port, pending);
    pending.set(row.id, {});
    setStatus("busy");
    let result: FoundStatus = "failed";
    try {
      if (act === "add" && target) {
        const outcome = await addFound(port, row, target);
        pending.set(row.id, { key: outcome.key });
        result = outcome.verdict === null ? "queued" : outcome.verdict.kind === "taken" ? "added" : "failed";
      } else if (act === "dismiss" && port.setSuggestionDismissed) {
        await port.setSuggestionDismissed(row.id, true);
        result = "dismissed";
      }
    } catch {
      result = "failed";
    } finally {
      if (result !== "queued" && result !== "added") pending.delete(row.id);
      if (alive.current) setStatus(result);
    }
  };
  const already = row.alreadyOn !== null || status === "added";
  const waiting = status === "queued" || (!already && pendingByPort.get(port)?.get(row.id)?.key !== undefined);
  const locked = already || status === "busy" || waiting;
  // Show the calendar day in the result regardless of the device time zone.
  const date = new Date(row.day);
  const locale = activeLocale();
  const when = date.toLocaleDateString(locale === "en" ? "en-GB" : locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: t.c.hair, borderRadius: t.radius.row, padding: 9, gap: 7 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Icon name="calendar" size={16} color={t.c.ink2} />
        <View style={{ flex: 1, minWidth: 94 }}>
          <Txt variant="body" numberOfLines={2}>
            <Txt variant="button">{when}</Txt>{"  "}{row.title}
          </Txt>
          {row.place ? <Txt variant="caption" tone="ink2" numberOfLines={1}>{row.place}</Txt> : null}
        </View>
        {target && !already ? (
          <Tap accessibilityRole="button" accessibilityLabel={Copy.mailEventAdd} disabled={locked}
            onPress={() => { void take("add"); }}
            style={{ backgroundColor: t.c.accent, borderRadius: t.radius.focus, paddingHorizontal: 7, paddingVertical: 4 }}>
            <Txt variant="button" style={{ color: mailColors(t)["on-hot"] }}>{Copy.mailEventAdd}</Txt>
          </Tap>
        ) : null}
        {port.setSuggestionDismissed && !already ? (
          <Tap accessibilityRole="button" accessibilityLabel={Copy.mailEventDismiss} disabled={locked}
            onPress={() => { void take("dismiss"); }} style={{ padding: 7 }}>
            <Icon name="x" size={13} color={t.c.ink2} />
          </Tap>
        ) : null}
      </View>
      {already || status === "failed" || waiting ? (
        <Txt variant="caption" tone="ink2" accessibilityLiveRegion="polite">
          {already ? Copy.mailEventOnCalendar : waiting ? Copy.mailEventQueued : Copy.mailEventFailed}
        </Txt>
      ) : null}
    </View>
  );
}
