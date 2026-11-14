/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { NextIntlClientProvider } from "next-intl";
import {
  MutationRejectedError, OhmailEngine, type EngineAdapter, type EngineMutation,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import { useComposeAutosave, AUTOSAVE_DELAY_MS } from "@ohmail/app-logic/writing/compose-autosave";
import {
  COMPOSE_SEND_KEY, SENT_BEAT_MS, canCancel, useMailSend, type MailSendApi,
} from "@ohmail/app-logic/writing/mail-send";
import { useMailSendText } from "../app/shell/mail-send-text";
import {
  EMPTY_COMPOSE, clearComposeDraft, composeSessionId, composeSessionKey, readComposeDraft,
  readComposeRow, writeComposeDraft, writeComposeRow, type ComposeFields,
} from "@ohmail/app-logic/writing/compose";
/* The shell's Cancel road is inline in a file of several thousand lines and the claim is an
   ORDER — the withdrawal standing before the discard — which no mounted component can show. The
   anchor rule, and what a hook spelling costs, are written out in the helper. */
import { sliceOfDeclaration } from "./source-anchor.js";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * ═══ ONE COMPOSER PER DRAFT ══════════════════════════════════════════════════════════════
 *
 * A draft has ONE owner at a time. Settling one message may not touch another, and a composer
 * that has been released subscribes to nothing. Both halves of that were broken in the same
 * direction — the composer's identity was AMBIENT, a "current" scratch and a subscription that
 * outlived the composer that opened it — so a settlement or a hydration acted on whichever
 * message happened to be open rather than the one it was for.
 *
 * The line these cases defend: a draft the person is typing is never discarded by another
 * draft's lifecycle.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

/** Every mutation the engine dispatched, in order. */
let sent: EngineMutation[];
let seq: number;
/** Draft rows the mirror knows about — seeded per case, so `holdOf` can answer. */
let mirror: Record<string, { id: string; status: string }>;
/** Resolve the next `mail_send` by hand, so a case can act WHILE the send is out. */
let releaseSend: ((v: unknown) => void) | null;
/** Whether a `mail_send` waits at the door. Off where a case needs the delivery to complete. */
let holdSend: boolean;
/** No signal: every verb is refused retryably, which is what puts one on the outbox. */
let offline: boolean;
/** Every `mail_send` the adapter was actually asked to make — the deliveries. */
let delivered: EngineMutation[];
/** The keys the server holds a delivery under — what its withdraw answers `already_sent` for. */
let deliveredKeys: Set<string>;

function adapterWith(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({
      changes: {
        creates: Object.values(mirror).map((d, i) => ({
          type: "draft", op: "create", id: d.id, seq: 1000 + i,
          updatedAt: "2026-09-14T00:00:00.000Z", entity: d,
        })),
        updates: [], moves: [], deletes: [],
      },
      cursor: `c-${Object.keys(mirror).length}`, hasMore: false,
      serverTime: "2026-09-14T00:00:00.000Z",
    }) as never,
    mutate: (async (m: EngineMutation, o?: { idempotencyKey: string }) => {
      if (offline) {
        throw new MutationRejectedError("no signal", { code: "network", retryable: true });
      }
      sent.push(m);
      const n = ++seq;
      if (m.kind === "mail_send") {
        delivered.push(m);
        if (o?.idempotencyKey) deliveredKeys.add(o.idempotencyKey);
        if (holdSend) await new Promise((r) => { releaseSend = r; });
        return { changes: [], seq: n, entityId: null };
      }
      if (m.kind === "draft_save") {
        const id = m.draftId ?? `srv-new-${n}`;
        return {
          changes: [{
            type: "draft", op: m.draftId === null ? "create" : "update", id, seq: n,
            updatedAt: "2026-09-14T00:00:00.000Z",
            entity: { id, mailboxId: "mb-1", status: "draft" } as unknown as Record<string, unknown>,
          }] as never,
          seq: n, entityId: id,
        };
      }
      if (m.kind === "draft_discard") {
        return {
          changes: [{
            type: "draft", op: "delete", id: m.draftId, seq: n,
            updatedAt: "2026-09-14T00:00:00.000Z", entity: null,
          }] as never,
          seq: n,
        };
      }
      return { changes: [], seq: n };
    }) as EngineAdapter["mutate"],
    // The server's withdraw: a key it delivered is already sent, any other is tombstoned. The Cancel's
    // own request reaches it; only the queued send's attempt went out with no signal.
    withdrawSend: async (key: string) => (deliveredKeys.has(key)
      ? { outcome: "already_sent" as const, firstSend: { status: "sent", at: "2026-09-14T00:00:00.000Z" } }
      : { outcome: "withdrawn" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let autosave: ReturnType<typeof useComposeAutosave>;
let mailSend: MailSendApi;
/** Every `(key, mutation)` `useMailSend` settled — the shell's `onSendSettled` seam. */
let settledWith: Array<{ key: string; draftId: string | null }>;
/** How many times the shell was told "the compose is over" — `AppShell.onCleared`. */
let cleared: number;

const typed = (over: Partial<ComposeFields> = {}): ComposeFields => ({
  ...EMPTY_COMPOSE, to: "sam@example.com", subject: "Friday", body: "Are we still on?", ...over,
});

function AutosaveHarness({ engine, fields }: { engine: OhmailEngine; fields: ComposeFields }) {
  autosave = useComposeAutosave({ engine, fields, mailboxId: "mb-1", active: true, scope: storageOwner() });
  return null;
}

/**
 * THE SHELL'S OWN WIRING, modelled: `useMailSend`'s settlement reaches `useComposeAutosave`
 * through `AppShell.onSendSettled`, carrying the verdict the send took at the confirmation. The
 * decision under test is made in `settle` and spent in `settleCompose`, so a harness that drove
 * either half alone would be asserting about its own argument.
 */
function ShellHarness({ engine, fields }: { engine: OhmailEngine; fields: ComposeFields }) {
  const settleRef = React.useRef<(rowId: string | null, about: boolean) => void>(() => {});
  mailSend = useMailSend(engine, storageOwner(), () => {}, useMailSendText(), (key, m, aboutThisCompose) => {
    settledWith.push({ key, draftId: (m as { draftId?: string | null }).draftId ?? null });
    if (key === COMPOSE_SEND_KEY) settleRef.current((m as { draftId?: string | null }).draftId ?? null, aboutThisCompose);
  });
  autosave = useComposeAutosave({
    engine, fields, mailboxId: "mb-1", active: true,
    onCleared: () => { cleared += 1; },
    scope: storageOwner(),
  });
  settleRef.current = (rowId, about) => {
    autosave.settleCompose({ kind: "sentByMirror", rowId, aboutThisCompose: about });
  };
  return null;
}

async function mount(el: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">{el}</NextIntlClientProvider>,
    );
  });
}

/** Let every promise the last act started settle, without moving the debounce on. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 60; i += 1) {
      await Promise.resolve();
      vi.advanceTimersByTime(1);
    }
  });
}

/** Run the autosave debounce out. */
async function debounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 10);
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
  });
}

/**
 * THE DOOR THAT PUTS ANOTHER MESSAGE IN THE COMPOSER — exactly what `openDraft` does: the
 * previous message's buffer, row and session go, and the new one is written in their place.
 */
function openAnother(rowId: string, fields: ComposeFields): void {
  clearComposeDraft(storageOwner());
  writeComposeDraft(fields, storageOwner());
  writeComposeRow(rowId, storageOwner());
}

beforeEach(() => {
  sent = [];
  seq = 0;
  mirror = {};
  releaseSend = null;
  holdSend = true;
  offline = false;
  delivered = [];
  deliveredKeys = new Set();
  settledWith = [];
  cleared = 0;
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("settling one message never touches another", () => {
  /** Press Send on the compose lane for the message the composer is holding. */
  const press = async (draftId: string | null, subject: string, body: string): Promise<void> => {
    await act(async () => {
      mailSend.send({
        kind: "mail_send", draftId, inReplyTo: null, mailboxId: "mb-1",
        to: [{ name: null, address: "sam@example.com" }], subject, body,
      } as never);
    });
    await drain();
  };

  /** Let the send answer, then run the sent-beat out so the surface half settles too. */
  const confirm = async (): Promise<void> => {
    await act(async () => { releaseSend?.(undefined); });
    await drain();
    await act(async () => { vi.advanceTimersByTime(SENT_BEAT_MS + 50); });
    await drain();
  };

  /**
   * ── ITEM A ─────────────────────────────────────────────────────────────────────────────
   *
   * Send A, open B while A is still out, let A confirm. A's settlement used to act on
   * whatever compose was open: it cleared THE CURRENT scratch, and its phantom-copy branch —
   * "this hook holds a row the send did not use, so it is a copy of the delivered message" —
   * DELETED B's row from the account. The person watched the message they were writing lose
   * its text and its row because an unrelated send finished.
   *
   * Mutation that reddens it: `const aboutThisCompose = true` in `settle`.
   */
  it("a send that lands while another draft is open leaves that draft alone", async () => {
    mirror["srv-a"] = { id: "srv-a", status: "draft" };
    mirror["srv-b"] = { id: "srv-b", status: "draft" };
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await engine.syncOnce();

    // The composer is holding A, and A is what Send is pressed on.
    writeComposeDraft(typed({ subject: "A", body: "A body" }), storageOwner());
    writeComposeRow("srv-a", storageOwner());
    const sessionA = composeSessionId(storageOwner());
    await mount(h(ShellHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    await act(async () => { autosave.adopt("srv-a", typed({ subject: "A", body: "A body" })); });
    await press("srv-a", "A", "A body");

    // …and while it is out, the person opens draft B and starts typing in it.
    const bFields = typed({ subject: "B", body: "B body — still being written" });
    openAnother("srv-b", bFields);
    await act(async () => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
          <ShellHarness engine={engine} fields={bFields} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { autosave.adopt("srv-b", bFields); });
    expect(composeSessionId(storageOwner()), "the door did not re-mint the session").not.toBe(sessionA);

    await confirm();

    /* THE ROW FIRST, because it is the half nothing can put back: `settleCompose`'s phantom-copy
       branch DELETES it from the account. The buffer below is the half the person sees go. */
    expect(
      sent.filter((m) => m.kind === "draft_discard"),
      "another message's settlement deleted the open draft's row",
    ).toHaveLength(0);
    expect(autosave.draftId, "the open draft lost its row").toBe("srv-b");
    expect(
      readComposeDraft(storageOwner()).body,
      "sending one message emptied the draft the person was writing",
    ).toBe("B body — still being written");
    expect(readComposeRow(storageOwner()), "sending one message dropped another message's row").toBe("srv-b");
    expect(cleared, "the composer was emptied under the cursor").toBe(0);
  });

  /**
   * THE POSITIVE CONTROL. An ordinary send — nothing opened over it — still clears its own
   * scratch, lets go of its row and closes the surface. Without this the fix could be "never
   * clear", which resurrects sent text into the next compose (the other hard stop).
   */
  it("an ordinary send still clears its own scratch and closes the compose", async () => {
    mirror["srv-a"] = { id: "srv-a", status: "draft" };
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await engine.syncOnce();

    writeComposeDraft(typed({ subject: "A", body: "A body" }), storageOwner());
    writeComposeRow("srv-a", storageOwner());
    await mount(h(ShellHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    await act(async () => { autosave.adopt("srv-a", typed({ subject: "A", body: "A body" })); });
    await press("srv-a", "A", "A body");
    await confirm();

    expect(readComposeDraft(storageOwner()).body, "the delivered text stayed in the buffer").toBe("");
    expect(readComposeRow(storageOwner())).toBeNull();
    expect(autosave.draftId, "the delivered row was still held").toBeNull();
    expect(cleared, "the surface never closed over a delivered message").toBe(1);
  });

  /**
   * AND IT GOES AT THE CONFIRMATION, NOT AT THE BEAT. The surface stays up for
   * {@link SENT_BEAT_MS} after a delivery so the reader sees "Sent", and a reload inside that
   * window restores the buffer — so the delivered text has to be out of it already. The close
   * that follows clears again and is idempotent; this measures the earlier one on its own,
   * which the pair would otherwise hide.
   *
   * Mutation that reddens it: `if (false) clearComposeDraft(owner)` in `clearLaneScratch`.
   */
  it("the delivered text leaves the buffer at the confirmation, before the sent beat", async () => {
    mirror["srv-a"] = { id: "srv-a", status: "draft" };
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await engine.syncOnce();

    writeComposeDraft(typed({ subject: "A", body: "A body" }), storageOwner());
    writeComposeRow("srv-a", storageOwner());
    await mount(h(ShellHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    await act(async () => { autosave.adopt("srv-a", typed({ subject: "A", body: "A body" })); });
    await press("srv-a", "A", "A body");

    // The answer lands; the beat is deliberately NOT run out.
    await act(async () => { releaseSend?.(undefined); });
    await drain();

    expect(cleared, "the beat ran, so this measures the close and not the confirmation").toBe(0);
    expect(
      readComposeDraft(storageOwner()).body,
      "a reload inside the sent beat would bring the delivered message back into the composer",
    ).toBe("");
  });

  /**
   * THE POSITIVE CONTROL for the phantom-copy branch: a send pressed before the first save
   * made its own row on the server, this hook adopted a SECOND row for the same message in
   * the meantime, and that row is still deleted — leaving it in Drafts is a reopenable copy
   * of a delivered message with Send live.
   */
  it("a real phantom copy is still discarded", async () => {
    mirror["srv-p"] = { id: "srv-p", status: "draft" };
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await engine.syncOnce();

    writeComposeDraft(typed({ subject: "A", body: "A body" }), storageOwner());
    await mount(h(ShellHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    // Pressed with no row of its own…
    await press(null, "A", "A body");
    // …and the armed save landed while the send was out: a second row for one message.
    await act(async () => { autosave.adopt("srv-p", typed({ subject: "A", body: "A body" })); });
    await confirm();

    expect(
      sent.filter((m) => m.kind === "draft_discard").map((m) => (m as { draftId: string }).draftId),
      "the phantom copy was left in Drafts, reopenable with Send live",
    ).toEqual(["srv-p"]);
  });
});

describe("a released composer subscribes to nothing", () => {
  /**
   * ── ITEM B ─────────────────────────────────────────────────────────────────────────────
   *
   * Come back to a bound row the mirror cannot yet speak for: the adoption WAITS on the
   * engine's notifications. `release()` used to leave that subscription standing, so when the
   * mirror finally answered it adopted the OLD row's id into whatever composer was on screen
   * — and the next autosave wrote that composer's text over the old message.
   *
   * Mutation that reddens it: drop the `off` teardown out of `release`.
   */
  it("a release ends the adoption it opened, and a late answer overwrites nothing", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await engine.syncOnce();

    // Bound to A, and the mirror has nothing to say about it yet.
    writeComposeRow("srv-a", storageOwner());
    await mount(h(AutosaveHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    expect(autosave.draftId, "the adoption did not wait for the mirror").toBeNull();

    // The composer is released and another message is put in it.
    await act(async () => { autosave.release(); });
    openAnother("srv-b", typed({ subject: "B", body: "B body" }));

    // The mirror arrives. A's row is a plain draft now, so the standing adoption would take it.
    mirror["srv-a"] = { id: "srv-a", status: "draft" };
    await act(async () => { await engine.syncOnce(); });
    await drain();

    expect(
      autosave.draftId,
      "a released composer adopted the row it had let go of",
    ).toBeNull();

    // …and the proof that matters: B's text is never written over A's row.
    await act(async () => {
      root!.render(
        <NextIntlClientProvider locale="en" messages={en as never} timeZone="UTC">
          <AutosaveHarness engine={engine} fields={typed({ subject: "B", body: "B body" })} />
        </NextIntlClientProvider>,
      );
    });
    await debounce();
    expect(
      sent.filter((m) => m.kind === "draft_save" && (m as { draftId: string | null }).draftId === "srv-a"),
      "the new message's text was written over the released row",
    ).toHaveLength(0);
  });

  /**
   * AND THE OTHER HALF, WHERE THE TEARDOWN CANNOT HELP: opening a draft from the list ADOPTS a
   * row without releasing anything, so the wait is still standing when the mirror answers. Only
   * the refusal by name stops it re-pointing the composer at the row it was waiting on — and a
   * composer pointed at another message's row writes this message's text into it on the next
   * pause.
   *
   * Mutation that reddens it: drop the `readComposeRow() !== held` refusal out of the adoption.
   */
  it("a composer that has taken another row is not re-pointed at the one it waited on", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();

    writeComposeRow("srv-a", storageOwner());
    await mount(h(AutosaveHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    expect(autosave.draftId, "the adoption did not wait for the mirror").toBeNull();

    // The Drafts list opens B into this composer: a new row, no release.
    const bFields = typed({ subject: "B", body: "B body" });
    openAnother("srv-b", bFields);
    await act(async () => { autosave.adopt("srv-b", bFields); });

    // The mirror catches up on A, and the standing wait would take it.
    mirror["srv-a"] = { id: "srv-a", status: "draft" };
    mirror["srv-b"] = { id: "srv-b", status: "draft" };
    await act(async () => { await engine.syncOnce(); });
    await drain();

    expect(
      autosave.draftId,
      "the composer was re-pointed at the row it had been waiting on, under another message",
    ).toBe("srv-b");
    expect(readComposeRow(storageOwner())).toBe("srv-b");
  });

  /**
   * AND THE WAIT ITSELF IS ENDED, not merely out-voted. The refusal above and the teardown are
   * two mechanisms over one line, so each is measured on its own: this one watches the engine
   * subscription the adoption opened and asserts that `release()` closes it. A composer that has
   * let go of its row has no business being woken by every mirror notification for the rest of
   * the session.
   *
   * Mutation that reddens it: drop `adoptOff.current?.()` out of `release`.
   */
  it("release closes the engine subscription the adoption opened", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();

    /* Every unsubscribe handle the hook was given, and whether it has been used. The adoption is
       the only thing this harness subscribes for, so the set is exactly its own. */
    const handles: Array<{ off: boolean }> = [];
    const real = engine.subscribe.bind(engine);
    engine.subscribe = (cb: () => void) => {
      const seen = { off: false };
      handles.push(seen);
      const stop = real(cb);
      return () => { seen.off = true; stop(); };
    };

    writeComposeRow("srv-a", storageOwner());
    await mount(h(AutosaveHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    expect(handles, "the adoption did not wait, so this case measures nothing").toHaveLength(1);
    expect(handles[0]!.off).toBe(false);

    await act(async () => { autosave.release(); });
    expect(
      handles[0]!.off,
      "the released composer is still subscribed to every mirror notification",
    ).toBe(true);
  });

  /**
   * THE POSITIVE CONTROL: a composer that was NOT released still adopts its row when the
   * mirror catches up — the whole reason the subscription exists.
   */
  it("a composer that was not released still adopts its row when the mirror answers", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await engine.syncOnce();

    writeComposeRow("srv-a", storageOwner());
    await mount(h(AutosaveHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    expect(autosave.draftId).toBeNull();

    mirror["srv-a"] = { id: "srv-a", status: "draft" };
    await act(async () => { await engine.syncOnce(); });
    await drain();

    expect(autosave.draftId, "the adoption never fired").toBe("srv-a");
  });
});

/**
 * ═══ CANCEL CANCELS ══════════════════════════════════════════════════════════════════════
 *
 * The composer's Cancel rode the same lock as its fields, so it was DISABLED for exactly the
 * state in which cancelling means something: a send sitting on the outbox with no connection.
 * The person abandoned the message some other way, the intent stayed standing, and the next
 * reconnect delivered a message they had cancelled. One delivery, never two — which is why it
 * read as ordinary rather than as a defect.
 *
 * The engine half is `OhmailEngine.withdrawQueued` (the key marked in memory and the outbox row
 * marked on disk, so neither this session's flush nor a later boot can send it); this is the
 * webapp's half of the same press.
 */
describe("cancelling a queued send cancels it", () => {
  /* The deliveries here must COMPLETE — what is counted is whether the wire was reached at all,
     and a send held at the door would be one this case could not tell from one that never went. */
  beforeEach(() => { holdSend = false; });

  /** Press Send with no signal, so the verb lands on the outbox. */
  async function queueOffline(engine: OhmailEngine): Promise<void> {
    writeComposeDraft(typed({ subject: "A", body: "A body" }), storageOwner());
    await mount(h(ShellHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));
    offline = true;
    await act(async () => {
      mailSend.send({
        kind: "mail_send", draftId: null, inReplyTo: null, mailboxId: "mb-1",
        to: [{ name: null, address: "sam@example.com" }], subject: "A", body: "A body",
      } as never);
    });
    await drain();
    expect(mailSend.stateOf(COMPOSE_SEND_KEY).phase, "the send did not queue").toBe("queued");
  }

  /**
   * The signal comes back and the engine drains what it was holding — `flushPending` is the
   * reconnect path, the same one `useMailSend.flush` drives when the window goes online.
   */
  async function reconnect(engine: OhmailEngine): Promise<void> {
    offline = false;
    await act(async () => { await engine.flushPending(); });
    await drain();
    await act(async () => { await engine.flushPending(); });
    await drain();
  }

  /**
   * THE CONTROL. Send with no signal, cancel, reconnect: nothing is delivered.
   *
   * Mutation that reddens it: `return "close"` in place of the `engine.withdrawQueued` call in
   * `useMailSend.withdraw` — one delivery of a message the person cancelled.
   */
  it("a send queued with no signal is withdrawn by Cancel and never goes", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await queueOffline(engine);

    let said: string | null = null;
    await act(async () => { said = await mailSend.withdraw(COMPOSE_SEND_KEY); });
    expect(said, "Cancel did not take the send off the queue").toBe("close");

    await reconnect(engine);
    expect(
      delivered,
      "a message the person cancelled was delivered on the next connection",
    ).toHaveLength(0);
    expect(
      mailSend.stateOf(COMPOSE_SEND_KEY).phase,
      "the composer stayed locked on a send that no longer exists",
    ).toBe("idle");
  });

  /**
   * AND IT IS NOT A PROMISE THE PRODUCT CANNOT KEEP. A lane with nothing queued has nothing to
   * withdraw and Cancel carries on — the ordinary press, and the positive control for the arm
   * above never being reached.
   */
  it("a compose with no send out is cancelled without asking the engine", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    writeComposeDraft(typed({ subject: "A", body: "A body" }), storageOwner());
    await mount(h(ShellHarness, { engine, fields: typed({ subject: "A", body: "A body" }) }));

    let said: string | null = null;
    await act(async () => { said = await mailSend.withdraw(COMPOSE_SEND_KEY); });
    expect(said, "an ordinary Cancel was refused").toBe("close");
    expect(delivered).toHaveLength(0);
  });

  /**
   * AND A WITHDRAWN VERB OWES NO SENTENCE. A flush already carrying the row answers with the
   * rollback it made of it; "Send failed" over a send the person themselves cancelled is the
   * wrong sentence and there is no right one.
   *
   * Mutation that reddens it: drop the `OUTBOX_WITHDRAWN_CODE` arm at the top of `absorb`.
   */
  it("a withdrawn send leaves the composer idle, not failed", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await engine.hydrate();
    await queueOffline(engine);
    await act(async () => { await mailSend.withdraw(COMPOSE_SEND_KEY); });
    await reconnect(engine);

    const state = mailSend.stateOf(COMPOSE_SEND_KEY);
    expect(state.phase, "the cancelled send was reported as a failure").not.toBe("failed");
    expect(state.phase).toBe("idle");
  });
});

/**
 * ═══ WHEN CANCEL IS OFFERED ══════════════════════════════════════════════════════════════
 *
 * The composer reads one predicate for this and so does every other consumer — the same rule
 * `canSend` follows, and for the same reason: two copies of "may this be cancelled" is a second
 * place for the surface to offer or refuse the wrong thing.
 */
describe("Cancel is offered exactly when cancelling can do something", () => {
  /**
   * Mutation that reddens it: add `&& state.phase !== "queued"` back to `canCancel` — the shape
   * that shipped, where the one state worth cancelling was the one Cancel refused.
   */
  it("a queued send may be cancelled; one on the wire may not", () => {
    expect(
      canCancel({ phase: "queued" }, false),
      "a send waiting for a connection could not be cancelled, so it went on reconnect",
    ).toBe(true);
    expect(canCancel({ phase: "queued", accepted: true }, false)).toBe(true);
    expect(
      canCancel({ phase: "sending" }, false),
      "Cancel was offered over a request that has already left this device",
    ).toBe(false);
    // A HELD message: the send is owed an answer nobody has, and the row is the account's only
    // record that it happened.
    expect(canCancel({ phase: "queued" }, true)).toBe(false);
    expect(canCancel({ phase: "idle" }, true)).toBe(false);
    // …and the ordinary compose, which is most of them.
    expect(canCancel({ phase: "idle" }, false)).toBe(true);
    expect(canCancel({ phase: "failed", reason: "nope" }, false)).toBe(true);
  });
});

/**
 * ═══ THE SHELL'S CANCEL ROAD ═════════════════════════════════════════════════════════════
 *
 * `useMailSend.withdraw` is driven directly above; this is the wiring that reaches it. Read as
 * SOURCE because the claim is an order inside one callback — the withdrawal before the discard —
 * and a mounted shell shows the ending, not the sequence that produced it.
 */
describe("the compose cancel asks for the withdrawal before it destroys anything", () => {
  const shell = (): string => {
    const rel = "app/shell/shell-compose.ts";
    try {
      return readFileSync(resolve(process.cwd(), `apps/webapp/${rel}`), "utf8");
    } catch {
      return readFileSync(resolve(process.cwd(), rel), "utf8");
    }
  };

  /**
   * Mutation that reddens it: move the `mailSend.withdraw` line below `autosave.discard()` — the
   * row and the buffer would go first and the withdrawal would race its own cleanup.
   */
  it("withdraws, and only then discards the row and clears the buffer", () => {
    const body = sliceOfDeclaration(shell(), "cancelCompose");
    const withdrawAt = body.indexOf("mailSend.withdraw(COMPOSE_SEND_KEY)");
    const discardAt = body.indexOf("autosave.discard()");
    const clearAt = body.indexOf("clearComposeDraft(scope)");
    expect(withdrawAt, "the compose cancel never asks for the withdrawal").toBeGreaterThan(-1);
    expect(discardAt, "the compose cancel stopped discarding the row").toBeGreaterThan(-1);
    expect(clearAt, "the compose cancel stopped clearing the buffer").toBeGreaterThan(-1);
    expect(withdrawAt, "the row was discarded before the send was withdrawn").toBeLessThan(discardAt);
    expect(withdrawAt, "the buffer was cleared before the send was withdrawn").toBeLessThan(clearAt);
  });

  /**
   * AND `already_sent` DESTROYS NOTHING — the compose stays exactly as it is and the reader is
   * told. Read as the early return it is.
   *
   * Mutation that reddens it: drop the `return` out of that arm.
   */
  it("says so and leaves the compose alone when the request has already left", () => {
    const body = sliceOfDeclaration(shell(), "cancelCompose");
    const arm = body.indexOf('=== "already_sent"');
    expect(arm, "the cancel no longer distinguishes a send it could not withdraw").toBeGreaterThan(-1);
    const after = body.slice(arm, body.indexOf("autosave.discard()"));
    expect(after, "the reader is not told the message had already gone")
      .toContain("compose.cancelAlreadySent");
    expect(after, "the compose was destroyed over a delivery nobody can take back")
      .toContain("return;");
  });
});
