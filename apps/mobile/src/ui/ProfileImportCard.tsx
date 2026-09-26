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
  answerProfileImport, readProfileImport, type ProfileImportQuestion,
} from "../net/profile-import";
import type { ConnectedSession } from "../net/pairing";
import { useWorld } from "../state/world";
import { Button, Panel, Txt, useTopPad } from "./base";
import {
  cardQuestion, countsSaid, failureSaid, savedBySaid, savedRows,
  type CardPhase, type MailboxQuestion,
} from "./profile-import-card";

/** How soon a mailbox is asked again: an open answer rarely changes, a `none` can at any drain. */
const ASK_AGAIN_OPEN_MS = 5 * 60 * 1000;
const ASK_AGAIN_NONE_MS = 60 * 1000;

/**
 * Every mailbox's answer, asked on the session's own door when the mailbox read refreshes (after
 * each drain), throttled per mailbox. `set` lets a press record its own answer at once.
 */
export function useProfileQuestions(): {
  session: ConnectedSession | null;
  rows: MailboxQuestion[];
  set: (mailboxId: string, question: ProfileImportQuestion) => void;
} {
  const w = useWorld();
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  const [answers, setAnswers] = useState<Record<string, ProfileImportQuestion>>({});
  const asked = useRef(new Map<string, number>());
  const known = useRef(answers);
  known.current = answers;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (session === null) return;
    const now = Date.now();
    for (const row of w.mailboxes.rows) {
      const last = asked.current.get(row.id);
      const prior = known.current[row.id];
      const gap = prior === undefined || prior.state === "none" ? ASK_AGAIN_NONE_MS : ASK_AGAIN_OPEN_MS;
      if (last !== undefined && now - last < gap) continue;
      asked.current.set(row.id, now);
      void readProfileImport(session, row.id).then((q) => {
        if (mounted.current && q !== null) setAnswers((prev) => ({ ...prev, [row.id]: q }));
      });
    }
  }, [session, w.mailboxes.rows]);

  const set = useCallback((mailboxId: string, question: ProfileImportQuestion) => {
    asked.current.set(mailboxId, Date.now());
    setAnswers((prev) => ({ ...prev, [mailboxId]: question }));
  }, []);

  const rows = w.mailboxes.rows
    .filter((r) => answers[r.id] !== undefined)
    .map((r) => ({ mailboxId: r.id, address: r.displayName ?? r.address, question: answers[r.id]! }));
  return { session, rows, set };
}

export function ProfileImportCard() {
  const locale = useLocale();
  const top = useTopPad(8);
  const { session, rows, set } = useProfileQuestions();
  const [phase, setPhase] = useState<CardPhase>({ kind: "asking" });
  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = cardQuestion(rows);
  const q = current?.question;

  /* The card's phase belongs to the mailbox on screen; a different question starts fresh. */
  useEffect(() => {
    if (current !== null && current.mailboxId !== shownFor && phase.kind !== "imported") {
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
  const busy = phase.kind === "busy";
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
      <Txt variant="caption" tone="ink3">{Copy.pfiWillDo}</Txt>
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
  const { session, rows, set } = useProfileQuestions();
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
      put(verb === "import"
        ? { kind: "imported", details: a.imported === null ? "" : countsSaid(a.imported) }
        : { kind: "saved" });
      set(row.mailboxId, { state: "none" });
    });
  }, [session, locale, set]);

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
        const busy = phase.kind === "busy";
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
                  <Txt variant="caption" tone="ink3">
                    {details ? Copy.pfiReplaceNote(details) : Copy.pfiReplaceNoteBare}
                  </Txt>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                    <Button
                      label={busy && phase.verb === "import" ? Copy.pfiImporting : Copy.pfiImport}
                      variant="solid"
                      disabled={busy}
                      onPress={() => press(row, "import")}
                    />
                    <Button
                      label={busy && phase.verb === "save" ? Copy.pfiReplacing : Copy.pfiReplace}
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
