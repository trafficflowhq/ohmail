"use client";

/**
 * THE CHANGES THAT DID NOT GO THROUGH, LISTED: what the `unsaved` notice's "Show them" opens, over the app, in the
 * kit's dialog with a list (`Dialog`, one `WaitRow` a change). Each row says what the person was doing, why it did
 * not go through (the server's own sentence where it gave one a person can use, else that it gave none; a change
 * still waiting: why, from its own last attempt), and its two answers: Try again (re-queued under its ORIGINAL key, so
 * an attempt that committed and lost its answer replays rather than doing the thing twice) and Discard (a queued
 * change is withdrawn by its key: a withdrawn draft delete is never sent, and the draft stays). No Try again on a
 * change a newer one to the same thing has since replaced, nor on a refusal the record keeps. One row, one decision:
 * no "retry all". What a retry came to is said in its row, and where the retry took its row away (a send that may
 * already have left: "check your Sent folder") it is said over the answers, as long as the list stands.
 *
 * Moved in behaviour from the web shell's `UnsavedChangesList` (`apps/webapp/app/shell/UnsavedChanges.tsx`), drawn
 * with the kit's parts. The pure half (`UnsavedListOf`) takes the rows and the answers; `UnsavedList` binds them to
 * the engine the ground stands over, and is the list's ONE MOUNT: the composer's mount draws it inside the release
 * of a confirmed Send + Done (`WritingMount`), so a retry the account confirms files its source; the notice's "Show
 * them" opens it through `useShowUnsaved()`, which reaches every piece and pane under it.
 */
import { createContext, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AbandonedMutation, MutationResult, QueuedChange } from "@ohmail/client-engine";
import { Dialog, WaitRow } from "@ohmail/ui/base";
import { useAbandoned, useEngine } from "@ohmail/app-logic/engine";
import { copyRefused } from "@ohmail/app-logic/mail-state/mail-state";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { pressVerdict } from "@ohmail/app-logic/press";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { discardUnsavedChange } from "@ohmail/app-logic/writing/mail-send";
import { useSendRelease } from "@ohmail/app-logic/writing/send-release";
import { useText } from "../../text/index.js";

type Translate = (key: string, values?: Record<string, string | number>) => string;
/** What a press came to, by the row it was about. */
type Said = { readonly id: string; readonly message: string };
type Answer = "retry" | "discard";

/**
 * WHAT THE PERSON WAS DOING, in their words: an explicit map (a computed key would throw for a verb with no words, on
 * the one surface that exists because something already went wrong); an unlisted verb takes the generic sentence.
 */
const KIND_LABELS = new Map<string, string>(
  Object.entries({
    move: "unsavedKindMove",
    message_delete: "unsavedKindDelete",
    triage_set: "unsavedKindTriage",
    screener_decide: "unsavedKindScreener",
    mark_seen: "unsavedKindRead",
    feed_mark_seen: "unsavedKindRead",
    mail_send: "unsavedKindSend",
    draft_save: "unsavedKindDraft",
    draft_discard: "unsavedKindDraftDiscard",
    draft_accept: "unsavedKindDraft",
    draft_schedule_cancel: "unsavedKindSchedule",
    tag_assign: "unsavedKindTag",
    tag_create: "unsavedKindTag",
    tag_rename: "unsavedKindTag",
    tag_recolor: "unsavedKindTag",
    tag_delete: "unsavedKindTag",
    folder_create: "unsavedKindFolder",
    folder_rename: "unsavedKindFolder",
    folder_delete: "unsavedKindFolder",
    folder_op_dismiss: "unsavedKindFolder",
    rule_create: "unsavedKindRule",
    rule_update: "unsavedKindRule",
    rule_delete: "unsavedKindRule",
  }),
);
const whatOf = (t: Translate, kind: string): string => t(KIND_LABELS.get(kind) ?? "unsavedKindOther");

/** A refusal that says nothing a person can use: no code, the unhandled 500's "internal error", or no words. */
const opaque = (e: { code: string | null; message: string }): boolean =>
  e.code === null || e.code === "internal" || e.message.trim() === "";

/** The answers that mean the account was never reached: no wire, no answer in time, the renewal down. */
const UNREACHED = new Set(["network", "timeout", "offline_read_only"]);

/** Why a queued change has not gone through, from its own last attempt (today's `queuedReason`, word for word). */
function queuedWhy(m: QueuedChange, t: Translate, held: string | undefined): string {
  const e = m.error ?? null;
  if (e === null) return t("unsavedQueuedWaiting");
  if (e.code === "offline_read_only" && held !== undefined) return held;
  if (e.code !== null && UNREACHED.has(e.code)) return t("unsavedQueuedWhy");
  if (e.code === "not_signed_in") return e.message.trim() === "" ? t("unsavedQueuedWhy") : e.message;
  return opaque(e) ? t("unsavedQueuedServerWhy") : e.message;
}

export interface UnsavedListProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The notice's sentence: what could not be saved, or has not gone through yet. */
  readonly title: string;
  readonly abandoned: readonly AbandonedMutation[];
  readonly queued: readonly QueuedChange[];
  /** Why a change is held while this computer's copy refuses its own pull; none where it does not. */
  readonly held?: string;
  readonly onRetry: (id: string) => Promise<MutationResult>;
  readonly onDiscard: (id: string) => Promise<void>;
  readonly onRetryQueued: (id: string) => Promise<MutationResult | null>;
  /** Withdraws by the verb's key, the engine's handle for a queued verb. */
  readonly onDiscardQueued: (key: string) => Promise<void>;
  /** A confirmed retry of a Send + Done is released through the composer's one door, as every other road's. */
  readonly release?: ((outcome: MutationResult) => void) | null;
}

/** The pure half: the rows and their answers in, the kit's dialog out. */
export function UnsavedListOf(props: UnsavedListProps) {
  const { abandoned, queued } = props;
  const t = useText("sync") as Translate;
  const drafts = useText("drafts");
  const actionLocked = useRef(false);
  const [busy, setBusy] = useState<{ id: string; act: Answer } | null>(null);
  /** The last press's own sentence, where it had one, by the row it was about. */
  const [said, setSaid] = useState<Said | null>(null);

  // Lock before React renders the busy button, so two presses in one batch cannot both start.
  const run = useStableCallback(
    async (id: string, act: Answer, press: () => Promise<Said | null | undefined>) => {
      if (actionLocked.current) return;
      actionLocked.current = true;
      setBusy({ id, act });
      try {
        const next = await press();
        if (next !== undefined) setSaid(next);
      } finally {
        actionLocked.current = false;
        setBusy(null);
      }
    },
  );
  const retry = (id: string) =>
    run(id, "retry", async () => {
      const outcome = await props.onRetry(id);
      if (outcome.status === "confirmed" && outcome.andDone !== undefined) props.release?.(outcome);
      /* A send whose key had already gone is answered from that delivery: said, never sent again. */
      if (outcome.status === "confirmed" && outcome.firstSend !== undefined)
        return { id, message: t("unsavedSendAlreadyWent") };
      const e = outcome.error ?? null;
      return e === null ? null : { id, message: e.message };
    });
  const retryQueued = (id: string) =>
    run(id, "retry", async () => {
      const outcome = await props.onRetryQueued(id);
      /* The one reading of a result: only a refusal has a sentence for its row. */
      const verdict = outcome === null ? null : pressVerdict(outcome);
      return verdict?.kind === "refused" ? { id, message: verdict.refusal?.message ?? "" } : null;
    });
  const sentence = (message: string) => message || t("unsavedNoReason");

  const listed = abandoned.length + queued.length;
  const rowGone =
    said !== null && !abandoned.some((m) => m.id === said.id) && !queued.some((m) => m.id === said.id);
  const close = () => {
    setSaid(null);
    props.onClose();
  };
  return (
    <Dialog
      open={props.open && (listed > 0 || said !== null)}
      onClose={close}
      title={props.title}
      list
      keysOn="cancel"
      cancel={{ label: t("unsavedHide") }}
      said={rowGone ? { line: sentence(said.message), refused: true } : undefined}
    >
      {abandoned.map((m) => (
        <WaitRow
          key={m.id}
          what={whatOf(t, m.mutation.kind)}
          why={
            said?.id === m.id
              ? sentence(said.message)
              : m.superseded
                ? t("unsavedSuperseded")
                : opaque(m.error)
                  ? t("unsavedNoReason")
                  : m.error.code === "discard_unsupported"
                    ? drafts("discardUnsupported")
                    : m.error.message
          }
          refused
          acts={[
            /* No Try again once a newer change to the same thing was saved, nor on a refusal the record keeps. */
            ...(m.retryable
              ? [
                  {
                    label: t("unsavedRetry"),
                    onPress: () => void retry(m.id),
                    busy: busy?.id === m.id && busy.act === "retry",
                  },
                ]
              : []),
            {
              label: t("unsavedDiscard"),
              onPress: () => void run(m.id, "discard", () => props.onDiscard(m.id).then(() => undefined)),
              busy: busy?.id === m.id && busy.act === "discard",
            },
          ]}
        />
      ))}
      {queued.map((m) => (
        <WaitRow
          key={m.id}
          what={whatOf(t, m.mutation.kind)}
          why={said?.id === m.id ? sentence(said.message) : queuedWhy(m, t, props.held)}
          acts={[
            {
              label: t("unsavedRetry"),
              onPress: () => void retryQueued(m.id),
              busy: busy?.id === m.id && busy.act === "retry",
            },
            {
              label: t("unsavedDiscard"),
              onPress: () =>
                void run(m.id, "discard", () => props.onDiscardQueued(m.key).then(() => undefined)),
              busy: busy?.id === m.id && busy.act === "discard",
            },
          ]}
        />
      ))}
    </Dialog>
  );
}

const NO_QUEUED: readonly QueuedChange[] = [];

/** The changes this browser holds that have not gone through yet, from the engine's own selector. */
export function useQueued(): readonly QueuedChange[] {
  const engine = useEngine();
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.queuedChanges(),
    () => NO_QUEUED,
  );
}

/** What could not be saved, or has not gone through yet, in today's words; null when nothing waits. The `unsaved`
 * notice's sentence and the list's title; its keys are the whole catalogue's (`sync.…`). */
export function unsavedTitle(t: Translate, abandoned: number, queued: number): string | null {
  if (abandoned > 0) return t("sync.unsavedCount", { count: abandoned });
  return queued > 0 ? t("sync.unsavedPendingCount", { count: queued }) : null;
}

/** "Show them": opens the list. Null until the list's mount stands above. */
const ShowUnsavedContext = createContext<(() => void) | null>(null);

/** The press that opens the list of the changes that did not go through, for the notice that offers it. */
export function useShowUnsaved(): () => void {
  const show = useContext(ShowUnsavedContext);
  if (show === null)
    throw new Error("useShowUnsaved: no list of the changes that did not go through is mounted above");
  return show;
}

/** The list's one mount, over the engine the ground stands over: what stands under it may open it. */
export function UnsavedList({ children }: { readonly children: ReactNode }) {
  const [listed, setListed] = useState(false);
  const show = useStableCallback(() => setListed(true));
  const engine = useEngine();
  const abandoned = useAbandoned();
  const queued = useQueued();
  const { mailboxes } = useMailState();
  const tm = useText("mailboxes");
  const sync = useText("sync") as Translate;
  const release = useSendRelease();
  /* Both of the title's keys are the sync words'. */
  const title = unsavedTitle(
    (key, values) => sync(key.slice("sync.".length), values),
    abandoned.length,
    queued.length,
  );
  return (
    <ShowUnsavedContext.Provider value={show}>
      {children}
      <UnsavedListOf
        open={listed}
        onClose={() => setListed(false)}
        title={title ?? ""}
        abandoned={abandoned}
        queued={queued}
        held={copyRefused(mailboxes) ? tm("desktopStateStoreRefused") : undefined}
        onRetry={(id) => engine.retryAbandoned(id)}
        onDiscard={(id) => discardUnsavedChange(engine, id)}
        onRetryQueued={(id) => engine.retryQueued(id)}
        onDiscardQueued={(key) => engine.withdrawQueued(key).then(() => undefined)}
        release={release}
      />
    </ShowUnsavedContext.Provider>
  );
}
