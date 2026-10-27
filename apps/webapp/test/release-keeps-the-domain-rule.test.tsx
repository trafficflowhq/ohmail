/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  consentIndex,
  decidedDestination,
  rulesList,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";
import type { ScreenerState, SpamRow } from "../app/shell/screener-state";

/**
 * A PRESS ABOUT ONE SENDER NEVER CHANGES HOW ANOTHER SENDER'S MAIL IS FILED. Releasing a sender a
 * DOMAIN rule held retargeted that rule, which released everyone at the domain. Each of the three
 * presses (release, back to Waiting, the pinned rescue) is driven against a fake engine twice — the
 * sender held by a domain rule, then by their own rule — and read at the adapter, in the mirror
 * and in the sentence each catalogue renders.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-24T10:00:00.000Z");
const ISO = "2026-09-24T09:00:00.000Z";
const DOMAIN = "lists.example.test";
const PRESSED = `news@${DOMAIN}`;
const OTHER = `offers@${DOMAIN}`;
const SCREENED: Folder = "ohmail/Screened";
const SPAM: Folder = "ohmail/Quarantine";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let seq = 0;
let sent: EngineMutation[] = [];
let toasts: string[] = [];

function msg(id: string, from: string, folder: Folder, hour = 9): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: `2026-09-24T0${hour}:00:00.000Z`, folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

function rule(id: string, kind: "sender" | "domain", match: string, destination: Folder, priority = 0): RuleDTO {
  return {
    id, kind, match, destination, priority, provenance: "promoted", enabled: true,
    subjectContains: null, bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  } as RuleDTO;
}

/** The server: every write the engine sends, applied the way the service does, and answered with its change. */
function engineOver(messages: EngineMessage[], rules: RuleDTO[]): Promise<OhmailEngine> {
  const msgs = new Map(messages.map((m) => [m.id, { ...m }]));
  const held = new Map(rules.map((r) => [r.id, { ...r }]));
  const change = (type: string, op: string, entity: { id: string }): SyncChange =>
    ({ type, op, id: entity.id, seq: ++seq, updatedAt: ISO, entity }) as SyncChange;
  const answer = (changes: SyncChange[]) => ({ changes, seq: changes.length ? seq : null });
  return (async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([
      ...messages.map((m) => change("message", "create", m)),
      ...rules.map((r) => change("rule", "create", r)),
    ]);
    return new OhmailEngine({
      store,
      now: () => NOW,
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
        }),
        mutate: async (m: EngineMutation) => {
          sent.push(m);
          switch (m.kind) {
            case "rule_create": {
              const r = rule(`r-new-${sent.length}`, m.ruleKind, m.match, m.destination);
              held.set(r.id, { ...r, provenance: "manual" });
              return answer([change("rule", "create", held.get(r.id)!)]);
            }
            case "rule_update": {
              const r = held.get(m.ruleId)!;
              r.destination = m.destination;
              return answer([change("rule", "update", { ...r })]);
            }
            case "rule_delete":
              held.delete(m.ruleId);
              return { changes: [], seq: null };
            case "move": {
              const x = msgs.get(m.messageId)!;
              x.folder = m.folder;
              return answer([change("message", "move", { ...x })]);
            }
            case "screener_decide": {
              const rep = msgs.get(m.senderId)!;
              const folder: Folder = m.dest === "spam" ? SPAM : SCREENED;
              const out: SyncChange[] = [];
              for (const x of msgs.values()) {
                if (x.from.address === rep.from.address && x.folder === "ohmail/Screener") {
                  x.folder = folder;
                  out.push(change("message", "move", { ...x }));
                }
              }
              const promoted = m.scope === "domain"
                ? rule("r-promoted", "domain", DOMAIN, folder)
                : rule("r-promoted", "sender", rep.from.address, folder);
              held.set(promoted.id, promoted);
              out.push(change("rule", "create", promoted));
              return answer(out);
            }
            default:
              return { changes: [], seq: null };
          }
        },
        fetchBody: async () => null,
      } as never,
    });
  })();
}

async function mount(engine: OhmailEngine, locale: "en" | "de" = "en"): Promise<{ get: () => ScreenerState }> {
  const { useScreenerState } = await import("../app/shell/screener-state.js");
  let latest: ScreenerState | null = null;
  function Probe(): null {
    const [v, setV] = React.useState(0);
    React.useEffect(() => engine.subscribe(() => setV((x) => x + 1)), []);
    latest = useScreenerState(engine, v, ((message: string) => { toasts.push(message); }) as never);
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC", now: NOW, children: h(Probe),
    }));
  });
  await settleFirstPaint();
  return { get: () => latest! };
}

const settle = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

/** A catalogue sentence with its holes filled — what the reader is shown, from the file they are shown it from. */
const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

const lastToast = (): string => toasts[toasts.length - 1] ?? "";
const rulesTouched = (id: string) =>
  sent.filter((m) => (m.kind === "rule_update" || m.kind === "rule_delete") && m.ruleId === id);
const ruleWrites = () => sent.filter((m) => m.kind.startsWith("rule_"));
/** Where the mirror's rules now file a sender — the one order's reading, the one the cutline presents by. */
const decided = (engine: OhmailEngine, address: string) =>
  decidedDestination(consentIndex(rulesList(engine.read())), address);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
  seq = 0;
  sent = [];
  toasts = [];
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const screenedMail = () => [msg("p1", PRESSED, SCREENED), msg("o1", OTHER, SCREENED, 8)];
const spamMail = () => [msg("p1", PRESSED, SPAM), msg("o1", OTHER, SPAM, 8)];

describe("Allow on a screened-out sender", () => {
  it("held by a DOMAIN rule: an address rule for them alone, the domain rule untouched, and the sentence names it", async () => {
    const engine = await engineOver(screenedMail(), [rule("r-dom", "domain", DOMAIN, SCREENED)]);
    const s = await mount(engine);
    const sender = s.get().screenedOut.find((x) => x.from.address === PRESSED);
    expect(sender, "the domain-held sender is not in Screened out").toBeTruthy();

    await act(async () => { s.get().allowScreened(sender!, "ohbox"); });
    await settle();

    expect(ruleWrites()).toEqual([
      { kind: "rule_create", ruleKind: "sender", match: PRESSED, destination: "INBOX", applyRetro: true },
    ]);
    expect(rulesTouched("r-dom"), "the domain rule was rewritten by one sender's press").toEqual([]);
    // Marked as the press's own: a letter the rule's release files decides no place of its own.
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "p1", folder: "INBOX", pressRule: true }]);
    // The invariant, read where the cutline reads it: this sender files to the Ohbox, the rest of the domain does not.
    expect(decided(engine, PRESSED)).toBe("INBOX");
    expect(decided(engine, OTHER), "another sender at the domain was released").toBe(SCREENED);
    expect(lastToast()).toBe(fill(en.screener.toastReleasedAddress, {
      dest: en.screener.pileOhbox, count: "1", sender: PRESSED, domain: DOMAIN,
    }));
  });

  it("held by their OWN rule: that rule is retargeted, nothing is created", async () => {
    const engine = await engineOver(screenedMail(), [
      rule("r-own", "sender", PRESSED, SCREENED), rule("r-other", "sender", OTHER, SCREENED),
    ]);
    const s = await mount(engine);
    const sender = s.get().screenedOut.find((x) => x.from.address === PRESSED)!;

    await act(async () => { s.get().allowScreened(sender, "ohbox"); });
    await settle();

    expect(ruleWrites()).toEqual([{ kind: "rule_update", ruleId: "r-own", destination: "INBOX" }]);
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "p1", folder: "INBOX", pressRule: true }]);
    expect(decided(engine, PRESSED)).toBe("INBOX");
    expect(decided(engine, OTHER)).toBe(SCREENED);
    expect(lastToast()).toBe(fill(en.screener.toastReleasedRuled, {
      dest: en.screener.pileOhbox, count: "1", sender: PRESSED,
    }));
  });

  it("a domain rule the address rule cannot outrank (a higher priority) is said, and nothing is sent", async () => {
    const engine = await engineOver(screenedMail(), [rule("r-dom", "domain", DOMAIN, SCREENED, 5)]);
    const s = await mount(engine);
    const sender = s.get().screenedOut.find((x) => x.from.address === PRESSED)!;

    await act(async () => { s.get().allowScreened(sender, "ohbox"); });
    await settle();

    expect(sent, "a press that cannot win wrote or moved something").toEqual([]);
    expect(lastToast()).toBe(fill(en.screener.toastReleaseRuleStands, {
      sender: PRESSED, place: en.screener.segScreened, domain: DOMAIN,
    }));
  });

  it("the German catalogue says the same thing", async () => {
    const engine = await engineOver(screenedMail(), [rule("r-dom", "domain", DOMAIN, SCREENED)]);
    const s = await mount(engine, "de");
    const sender = s.get().screenedOut.find((x) => x.from.address === PRESSED)!;
    await act(async () => { s.get().allowScreened(sender, "ohbox"); });
    await settle();
    expect(lastToast()).toBe(fill(de.screener.toastReleasedAddress, {
      dest: de.screener.pileOhbox, count: "1", sender: PRESSED, domain: DOMAIN,
    }));
  });
});

describe("Not spam → back to Waiting", () => {
  const spamRow = (s: { get: () => ScreenerState }): SpamRow => {
    const row = s.get().spam.find((x) => x.sender.from.address === PRESSED);
    expect(row, "the sender is not in the Spam segment").toBeTruthy();
    return row!;
  };

  it("held by a DOMAIN rule: unperformable, said with the rule and where to change it, nothing deleted", async () => {
    const engine = await engineOver(spamMail(), [rule("r-dom", "domain", DOMAIN, SPAM)]);
    const s = await mount(engine);

    await act(async () => { s.get().notSpamToWaiting(spamRow(s)); });
    await settle();

    expect(sent, "back to Waiting deleted or moved something under a domain rule").toEqual([]);
    expect(rulesList(engine.read()).map((r) => [r.id, r.destination])).toEqual([["r-dom", SPAM]]);
    expect(lastToast()).toBe(fill(en.screener.toastReleaseRuleStands, {
      sender: PRESSED, place: en.screener.segSpam, domain: DOMAIN,
    }));
  });

  it("held by their OWN rule: the rule is deleted and the mail goes back to the gate", async () => {
    const engine = await engineOver(spamMail(), [rule("r-own", "sender", PRESSED, SPAM)]);
    const s = await mount(engine);

    await act(async () => { s.get().notSpamToWaiting(spamRow(s)); });
    await settle();

    expect(ruleWrites()).toEqual([{ kind: "rule_delete", ruleId: "r-own" }]);
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "p1", folder: "ohmail/Screener" }]);
    expect(lastToast()).toBe(fill(en.screener.toastNotSpamWaiting, { sender: PRESSED }));
  });

  it("the German catalogue says the refusal too", async () => {
    const engine = await engineOver(spamMail(), [rule("r-dom", "domain", DOMAIN, SPAM)]);
    const s = await mount(engine, "de");
    await act(async () => { s.get().notSpamToWaiting(spamRow(s)); });
    await settle();
    expect(lastToast()).toBe(fill(de.screener.toastReleaseRuleStands, {
      sender: PRESSED, place: de.screener.segSpam, domain: DOMAIN,
    }));
  });
});

describe("Not spam → Ohbox on a sender marked spam this session (the pinned rescue)", () => {
  /** Mark the waiting sender spam at `scope`, let the window close, and hand back the pinned row. */
  async function pinned(scope: "sender" | "domain", locale: "en" | "de" = "en") {
    const engine = await engineOver([msg("h1", PRESSED, "ohmail/Screener"), msg("o1", OTHER, SPAM, 8)], []);
    const s = await mount(engine, locale);
    const waiting = s.get().waiting.find((x) => x.from.address === PRESSED);
    expect(waiting, "the stranger is not waiting at the gate").toBeTruthy();
    await act(async () => { s.get().decide(waiting!, "spam", { read: false, scope }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    const row = s.get().spam.find((x) => x.pinned);
    expect(row, "the spam decision did not pin the sender").toBeTruthy();
    sent = [];
    return { engine, s, row: row! };
  }

  it("a DOMAIN-scoped spam decision: an address rule for them alone, the domain rule stays", async () => {
    const { engine, s, row } = await pinned("domain");
    await act(async () => { s.get().notSpamToOhbox(row); });
    await settle();

    expect(ruleWrites()).toEqual([
      { kind: "rule_create", ruleKind: "sender", match: PRESSED, destination: "INBOX", applyRetro: true },
    ]);
    expect(rulesTouched("r-promoted"), "the domain spam rule was rewritten by one sender's rescue").toEqual([]);
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "h1", folder: "INBOX", pressRule: true }]);
    expect(decided(engine, PRESSED)).toBe("INBOX");
    expect(decided(engine, OTHER), "another sender at the domain was rescued").toBe(SPAM);
    expect(lastToast()).toBe(fill(en.screener.toastNotSpamOhboxAddress, { sender: PRESSED, domain: DOMAIN }));
  });

  it("a sender-scoped spam decision: their own rule is retargeted", async () => {
    const { engine, s, row } = await pinned("sender");
    await act(async () => { s.get().notSpamToOhbox(row); });
    await settle();

    expect(ruleWrites()).toEqual([{ kind: "rule_update", ruleId: "r-promoted", destination: "INBOX" }]);
    expect(sent.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "h1", folder: "INBOX", pressRule: true }]);
    expect(decided(engine, PRESSED)).toBe("INBOX");
    expect(lastToast()).toBe(fill(en.screener.toastNotSpamOhbox, { sender: PRESSED }));
  });

  it("the German catalogue names the domain rule", async () => {
    const { s, row } = await pinned("domain", "de");
    await act(async () => { s.get().notSpamToOhbox(row); });
    await settle();
    expect(lastToast()).toBe(fill(de.screener.toastNotSpamOhboxAddress, { sender: PRESSED, domain: DOMAIN }));
  });
});

describe("a Move out of a domain rule's pile holds an address rule, and Undo takes it back", () => {
  /** The shell's routing window over the same fake engine: `hold` a press, then close or undo it. */
  async function routingOver(engine: OhmailEngine) {
    const { useRoutingUndo } = await import("../app/shell/routing-undo.js");
    const out: EngineMutation[] = [];
    let latest: ReturnType<typeof useRoutingUndo> | null = null;
    function Probe(): null {
      latest = useRoutingUndo({
        read: () => engine.read(),
        send: async (m) => { out.push(m); return { status: "confirmed" as const }; },
        toast: (sentence) => { toasts.push(sentence); },
        copy: { gone: "gone", expired: () => "expired", correction: () => "correction" },
        owner: "acct", windowMs: 1_000, now: () => Date.now(),
      });
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(Probe)); });
    const opened = latest!.hold({
      id: "press-1", seedId: "p1", address: PRESSED, dest: "ohbox", messageIds: ["p1"],
      note: { sender: PRESSED, place: "Ohbox", count: 1 },
    });
    expect(opened.held, "the window did not hold the press").toBe(true);
    return { out, get: () => latest! };
  }

  beforeEach(() => { try { window.localStorage.clear(); } catch { /* no jar is its own case */ } });

  it("the window commits an address rule for this sender, never a rewrite of the domain rule", async () => {
    const engine = await engineOver(spamMail(), [rule("r-dom", "domain", DOMAIN, SPAM)]);
    const w = await routingOver(engine);
    expect(w.out, "a rule went out inside the undo window").toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(w.out).toEqual([
      { kind: "rule_create", ruleKind: "sender", match: PRESSED, destination: "INBOX", applyRetro: false },
    ]);
  });

  it("Undo inside the window: nothing is sent, the domain rule and the address rule alike", async () => {
    const engine = await engineOver(spamMail(), [rule("r-dom", "domain", DOMAIN, SPAM)]);
    const w = await routingOver(engine);
    await act(async () => { expect(w.get().undo(w.get().subjectOf(PRESSED))).toBe(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(w.out, "Undo let a rule out").toEqual([]);
  });
});

describe("releaseRules, the one ladder all three presses and the phone's mirror read", () => {
  it("their own rule AND a domain rule: only their own is retargeted, the domain rule stays", async () => {
    const { releaseRules } = await import("../app/shell/sender-screening.js");
    const engine = await engineOver(screenedMail(), [
      rule("r-own", "sender", PRESSED, SCREENED), rule("r-dom", "domain", DOMAIN, SCREENED),
    ]);
    expect(releaseRules(engine.read(), PRESSED, SCREENED, "INBOX")).toEqual({
      kind: "retarget", mutations: [{ kind: "rule_update", ruleId: "r-own", destination: "INBOX" }],
    });
  });

  it("an address rule already standing at the destination: nothing more is written", async () => {
    const { releaseRules } = await import("../app/shell/sender-screening.js");
    const engine = await engineOver(screenedMail(), [
      rule("r-dom", "domain", DOMAIN, SCREENED), rule("r-mine", "sender", PRESSED, "INBOX"),
    ]);
    expect(releaseRules(engine.read(), PRESSED, SCREENED, "INBOX")).toEqual({ kind: "address", mutations: [], domain: DOMAIN });
  });
});
