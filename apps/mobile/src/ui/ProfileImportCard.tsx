/**
 * THE FOUND-SETTINGS CARD, above the lists — the web shell's card on the phone, drawn in the
 * lifecycle strip's idiom. Import applies the exact document shown; Not now records the answer
 * and lets the organizer file strangers again. Settings lists a "Not now" whose document stands
 * ({@link SavedSettingsPanel}). What to say is `profile-import-card.ts`'s; the calls are the
 * seam's. A read that could not be made draws nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import { useConnection } from "../net/connection";
import {
  answerProfileImport, readImportStatus, readProfileImport, type ProfileImportAnswer, type ProfileImportQuestion,
} from "../net/profile-import";
import type { ConnectedSession } from "../net/pairing";
import { useWorld } from "../state/world";
import { Button, Panel, Txt, useTopPad } from "./base";
import {
  IMPORT_STATUS_BEAT_MS, askTickets, cardQuestion, countsSaid, failureSaid, importingSaid, mailboxesToAsk,
  savedBySaid, savedRows, type CardPhase, type MailboxQuestion,
} from "./profile-import-card";

/**
 * Every mailbox's answer, asked on the session's own door when the mailbox read refreshes (after
 * each drain), throttled per mailbox, and at once when the settings doorbell rings (an
 * organizer's find). `set` lets a press record its own answer at once.
 */
export function useProfileQuestions(): {
  session: ConnectedSession | null;
  rows: MailboxQuestion[];
  set: (mailboxId: string, question: ProfileImportQuestion) => void;
  bell: number | null;
} {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  const [answers, setAnswers] = useState<Record<string, ProfileImportQuestion>>({});
  const asked = useRef(new Map<string, number>());
  const [tickets] = useState(askTickets);
  const bell = w.mailboxes.settingsBell;
  const rung = useRef(bell);
  const known = useRef(answers);
  known.current = answers;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (session === null) return;
    const rang = rung.current !== bell;
    rung.current = bell;
    const now = Date.now();
    const ids = w.mailboxes.rows.map((r) => r.id);
    for (const id of mailboxesToAsk(ids, asked.current, known.current, now, rang)) {
      asked.current.set(id, now);
      const ticket = tickets.begin(id);
      void readProfileImport(session, id).then((q) => {
        if (mounted.current && q !== null && tickets.current(id, ticket)) setAnswers((prev) => ({ ...prev, [id]: q }));
      });
    }
  }, [session, w.mailboxes.rows, bell, tickets]);

  const set = useCallback((mailboxId: string, question: ProfileImportQuestion) => {
    asked.current.set(mailboxId, Date.now());
    tickets.supersede(mailboxId);
    setAnswers((prev) => ({ ...prev, [mailboxId]: question }));
  }, [tickets]);

  const rows = w.mailboxes.rows
    .filter((r) => answers[r.id] !== undefined)
    .map((r) => ({ mailboxId: r.id, address: r.displayName ?? r.address, question: answers[r.id]! }));
  return { session, rows, set, bell };
}

/**
 * A PRESS THE ORGANIZER IS FINISHING, asked about on the settings doorbell its answer rings and
 * on a slow beat for a door that rings nothing. `settle` receives each answer the read has.
 */
function useImportStatus(
  session: ConnectedSession | null, target: { mailboxId: string; fingerprint: string } | null,
  bell: number | null, settle: (a: ProfileImportAnswer) => void,
): void {
  const [beat, setBeat] = useState(0);
  const key = target === null ? null : JSON.stringify([target.mailboxId, target.fingerprint]);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    if (key === null) return;
    const id = setInterval(() => setBeat((n) => n + 1), IMPORT_STATUS_BEAT_MS);
    return () => clearInterval(id);
  }, [key]);
  useEffect(() => {
    if (session === null || target === null) return;
    let live = true;
    void readImportStatus(session, target.mailboxId, target.fingerprint).then((a) => {
      if (live && a !== null) settleRef.current(a);
    });
    return () => { live = false; };
  }, [session, key, bell, beat]);
}

export function ProfileImportCard() {
  const locale = useLocale();
  const top = useTopPad(8);
  const { session, rows, set, bell } = useProfileQuestions();
  const [phase, setPhase] = useState<CardPhase>({ kind: "asking" });
  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = cardQuestion(rows);
  const q = current?.question;

  /* The card's phase belongs to the mailbox on screen; a different question starts fresh. */
  useEffect(() => {
    if (current !== null && current.mailboxId !== shownFor && phase.kind !== "imported" && phase.kind !== "importing") {
      setShownFor(current.mailboxId);
      setPhase({ kind: "asking" });
    }
  }, [current, shownFor, phase.kind]);

  const press = useCallback((verb: "import" | "notNow") => {
    if (session === null || current === null || q === undefined) return;
    if (q.state !== "found" && q.state !== "newer") return;
    if (verb === "import" && q.state !== "found") return;
    const subject = q.state === "newer" ? { v: q.v } : { fingerprint: q.fingerprint };
    setPhase({ kind: "busy" });
    void answerProfileImport(session, current.mailboxId, verb, subject).then((a) => {
      if (a.kind === "refused") { setPhase({ kind: "failed", message: a.message }); return; }
      if (a.kind === "importing") { setPhase({ kind: "importing", fingerprint: a.fingerprint, reason: a.reason }); return; }
      if (verb === "import") {
        setPhase({
          kind: "imported",
          details: a.imported === null ? "" : countsSaid(a.imported),
          skippedRules: a.skippedRules,
        });
        set(current.mailboxId, { state: "none" });
        return;
      }
      /* "Not now" on a found document leaves it standing: Settings shows it from here on. */
      set(current.mailboxId, q.state === "found" ? { ...q, state: "declined" } : { state: "none" });
      setPhase({ kind: "asking" });
    });
  }, [session, current, q, locale, set]);
  const importingFor = phase.kind === "importing" && current !== null
    ? { mailboxId: current.mailboxId, fingerprint: phase.fingerprint } : null;
  useImportStatus(session, importingFor, bell, (a) => {
    if (a.kind === "refused") { setPhase({ kind: "failed", message: a.message }); return; }
    if (a.kind !== "done") return;
    setPhase({ kind: "imported", details: a.imported === null ? "" : countsSaid(a.imported), skippedRules: a.skippedRules });
    if (importingFor !== null) set(importingFor.mailboxId, { state: "none" });
  });

  if (phase.kind === "imported") {
    return (
      <Panel style={{ marginHorizontal: 16, marginTop: top, padding: 14, gap: 8 }}>
        <Txt variant="body" accessibilityRole="summary">{Copy.pfiDoneTitle}</Txt>
        {phase.details ? <Txt variant="note" tone="ink2">{Copy.pfiDoneDetails(phase.details)}</Txt> : null}
        {phase.skippedRules > 0 ? <Txt variant="note" tone="ink2">{Copy.pfiDoneSkipped(phase.skippedRules)}</Txt> : null}
        <Button label={Copy.pfiDoneAction} variant="quiet" onPress={() => setPhase({ kind: "asking" })} />
      </Panel>
    );
  }
  if (current === null || q === undefined || (q.state !== "found" && q.state !== "newer")) return null;
  const busy = phase.kind === "busy" || phase.kind === "importing";
  const failed = phase.kind === "failed" ? failureSaid(phase.message) : null;

  if (q.state === "newer") {
    return (
      <Panel style={{ marginHorizontal: 16, marginTop: top, padding: 14, gap: 8 }}>
        <Txt variant="body" accessibilityRole="summary">{Copy.pfiNewerTitle}</Txt>
        <Txt variant="note" tone="ink2">{Copy.pfiNewerBody(current.address)}</Txt>
        {failed !== null ? <Txt variant="note" tone="ink2" accessibilityRole="alert">{failed}</Txt> : null}
        <Button label={Copy.pfiLater} variant="quiet" disabled={busy} onPress={() => press("notNow")} />
      </Panel>
    );
  }

  const details = countsSaid(q.counts);
  const savedBy = savedBySaid(q.producer, q.updatedAt, locale);
  return (
    <Panel style={{ marginHorizontal: 16, marginTop: top, padding: 14, gap: 8 }}>
      <Txt variant="body" accessibilityRole="summary">{Copy.pfiTitle}</Txt>
      <Txt variant="note" tone="ink2">{Copy.pfiLede(current.address)}</Txt>
      {details ? <Txt variant="note" tone="ink2">{Copy.pfiHolds(details)}</Txt> : null}
      {savedBy !== null ? <Txt variant="caption" tone="ink3">{savedBy}</Txt> : null}
      {failed !== null ? <Txt variant="note" tone="ink2" accessibilityRole="alert">{failed}</Txt> : null}
      {phase.kind === "importing" ? <Txt variant="note" tone="ink2">{importingSaid(phase.reason)}</Txt> : null}
      <Txt variant="caption" tone="ink3">{Copy.pfiWillDo}</Txt>
      <Txt variant="caption" tone="ink3">{Copy.pfiHeldRouting}</Txt>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button
          label={busy ? Copy.pfiImporting : Copy.pfiImport}
          variant="solid"
          disabled={busy}
          onPress={() => press("import")}
        />
        <Button label={Copy.pfiLater} variant="quiet" disabled={busy} onPress={() => press("notNow")} />
      </View>
    </Panel>
  );
}

type RowPhase =
  | { kind: "idle" }
  | { kind: "busy"; verb: "import" | "save" }
  | { kind: "importing"; fingerprint: string; reason: "slow" | "unreachable" | null }
  | { kind: "failed"; message: string | null }
  | { kind: "imported"; details: string }
  | { kind: "saved" };

/**
 * SETTINGS: THE DOCUMENTS ANSWERED "NOT NOW". Each keeps the other install's settings in the
 * mailbox and this phone's off it until the person imports them or saves this ohmail's in their
 * place. Draws nothing where nothing was declined.
 */
export function SavedSettingsPanel() {
  const locale = useLocale();
  const { session, rows, set, bell } = useProfileQuestions();
  const [phases, setPhases] = useState<Record<string, RowPhase>>({});
  /* A row stays on screen after its press so its verdict can be read; the door answers `none` next. */
  const [pressed, setPressed] = useState<Record<string, MailboxQuestion>>({});

  const press = useCallback((row: MailboxQuestion, verb: "import" | "save") => {
    if (session === null || row.question.state !== "declined") return;
    const put = (p: RowPhase): void => setPhases((prev) => ({ ...prev, [row.mailboxId]: p }));
    put({ kind: "busy", verb });
    setPressed((prev) => ({ ...prev, [row.mailboxId]: row }));
    void answerProfileImport(session, row.mailboxId, verb, { fingerprint: row.question.fingerprint }).then((a) => {
      if (a.kind === "refused") { put({ kind: "failed", message: a.message }); return; }
      if (a.kind === "importing") { put({ kind: "importing", fingerprint: a.fingerprint, reason: a.reason }); return; }
      put(verb === "import"
        ? { kind: "imported", details: a.imported === null ? "" : countsSaid(a.imported) }
        : { kind: "saved" });
      set(row.mailboxId, { state: "none" });
    });
  }, [session, locale, set]);
  /* One handed-over press at a time is asked about; a second waits behind the first's answer. */
  const waiting = Object.entries(phases).find(([, p]) => p.kind === "importing") as
    [string, Extract<RowPhase, { kind: "importing" }>] | undefined;
  useImportStatus(session, waiting ? { mailboxId: waiting[0], fingerprint: waiting[1].fingerprint } : null, bell, (a) => {
    if (waiting === undefined) return;
    const [mailboxId] = waiting;
    if (a.kind === "refused") { setPhases((prev) => ({ ...prev, [mailboxId]: { kind: "failed", message: a.message } })); return; }
    if (a.kind !== "done") return;
    setPhases((prev) => ({ ...prev, [mailboxId]: { kind: "imported", details: a.imported === null ? "" : countsSaid(a.imported) } }));
    set(mailboxId, { state: "none" });
  });

  const listed = [
    ...savedRows(rows),
    ...Object.values(pressed).filter((p) => !savedRows(rows).some((r) => r.mailboxId === p.mailboxId)),
  ];
  if (listed.length === 0) return null;
  return (
    <>
      {listed.map((row) => {
        const q = row.question;
        if (q.state !== "declined") return null;
        const phase = phases[row.mailboxId] ?? { kind: "idle" };
        const details = countsSaid(q.counts);
        const savedBy = savedBySaid(q.producer, q.updatedAt, locale);
        const busy = phase.kind === "busy" || phase.kind === "importing";
        return (
          <Panel key={row.mailboxId} style={{ paddingVertical: 18, marginBottom: 14 }}>
            <View style={{ paddingHorizontal: 20, gap: 6 }}>
              <Txt variant="settingsLabel">{Copy.pfiSavedTitle(row.address)}</Txt>
              {details ? <Txt variant="note" tone="ink2">{Copy.pfiHolds(details)}</Txt> : null}
              {savedBy !== null ? <Txt variant="note" tone="ink3">{savedBy}</Txt> : null}
              <Txt variant="note" tone="ink2">{Copy.pfiSavedBody}</Txt>
              {phase.kind === "imported" ? (
                <>
                  <Txt variant="note" tone="ink2" accessibilityRole="summary">{Copy.pfiDoneTitle}</Txt>
                  {phase.details ? <Txt variant="note" tone="ink2">{Copy.pfiDoneDetails(phase.details)}</Txt> : null}
                </>
              ) : phase.kind === "saved" ? (
                <Txt variant="note" tone="ink2" accessibilityRole="summary">{Copy.pfiReplacedTitle}</Txt>
              ) : (
                <>
                  {phase.kind === "failed" ? (
                    <Txt variant="note" tone="ink2" accessibilityRole="alert">{failureSaid(phase.message)}</Txt>
                  ) : null}
                  {phase.kind === "importing" ? <Txt variant="note" tone="ink2">{importingSaid(phase.reason)}</Txt> : null}
                  <Txt variant="caption" tone="ink3">
                    {details ? Copy.pfiReplaceNote(details) : Copy.pfiReplaceNoteBare}
                  </Txt>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                    <Button
                      label={phase.kind === "importing" || (phase.kind === "busy" && phase.verb === "import") ? Copy.pfiImporting : Copy.pfiImport}
                      variant="solid"
                      disabled={busy}
                      onPress={() => press(row, "import")}
                    />
                    <Button
                      label={phase.kind === "busy" && phase.verb === "save" ? Copy.pfiReplacing : Copy.pfiReplace}
                      variant="quiet"
                      disabled={busy}
                      onPress={() => press(row, "save")}
                    />
                  </View>
                </>
              )}
            </View>
          </Panel>
        );
      })}
    </>
  );
}
