/** @vitest-environment jsdom */
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { sliceOfDeclaration } from "./source-anchor.js";

/**
 * "WE FOUND YOUR OHMAIL SETTINGS ON THIS MAILBOX" — the restore card, over the real hook.
 *
 * The server-side semantics (marker gating, natural-key apply, durable dismissal) are proven in
 * `packages/services`; the wire in `packages/api`. What only this level can prove:
 *
 *  1. A found document renders the card with the counts IN WORDS — the person is told what
 *     will come back before any button exists to press — plus the mailbox it travelled with,
 *     and both honest buttons.
 *  2. *Import settings* sends the exact fingerprint the card was built from, and the answer
 *     becomes the confirmation — counts again, skipped rules disclosed when the server says so.
 *  3. *Not now* records the durable dismissal (the POST carries the content's fingerprint)
 *     and the card leaves.
 *  4. A NEWER document gets its own sentence and NO import button — there is no path on this
 *     card to a lossy import.
 *  5. A refused apply keeps the card and the buttons, with the SERVER's sentence above them —
 *     the person's decision survives a failed request.
 *  6. Inactive (demo / no server) asks NOTHING — the stub is primed with a found document, so
 *     a mutated gate turns both assertions red rather than vacuously green.
 *  7. The shell wiring is pinned by source, the away notice's way: a probe wiring its own copy
 *     of the gate cannot notice the AppShell ternary being edited away.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
// BEFORE any import of `api-client`: `API_BASE` is read once at module load.
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APP = existsSync("apps/webapp/app") ? "apps/webapp/app" : "app";
const read = (p: string): string => readFileSync(`${APP}/${p}`, "utf8");

const MB = { id: "6e0a4c1e-0000-4000-8000-000000000001", address: "mila@example.com" };
const MB2 = { id: "6e0a4c1e-0000-4000-8000-000000000002", address: "second@example.com" };
const FINGERPRINT = "a".repeat(64);

/** What the fake server currently says a check of MB would find. */
let candidate: Record<string, unknown>;
/** The fake server's applied answer. */
let applied: Record<string, unknown>;
/** When set, POST /profile-import answers this refusal instead of applying. */
let applyRefusal: { status: number; code: string; message: string } | null;
let declined: Array<Record<string, unknown>>;
let replacedBodies: Array<Record<string, unknown>>;

interface Recorded { method: string; path: string; body?: unknown }
let calls: Recorded[] = [];

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, body });
    if (path === `/mailboxes/${MB.id}/profile-import` && method === "GET") {
      return json(declined.length > 0 ? { state: "none" } : candidate);
    }
    if (path === `/mailboxes/${MB2.id}/profile-import` && method === "GET") {
      // The second mailbox carries its own travelling document — the account-switch tests need
      // a REAL offer waiting behind the stale one, or "the next question is reachable" is vacuous.
      return json({ ...candidate, fingerprint: "c".repeat(64) });
    }
    if (path === `/mailboxes/${MB.id}/profile-import` && method === "POST") {
      if (applyRefusal) {
        return json({ error: { code: applyRefusal.code, message: applyRefusal.message } }, applyRefusal.status);
      }
      return json(applied);
    }
    if (path === `/mailboxes/${MB.id}/profile-import/decline` && method === "POST") {
      declined.push(body ?? {});
      return json({ dismissed: true });
    }
    if (path === `/mailboxes/${MB.id}/profile-import/replace` && method === "POST") {
      replacedBodies.push(body ?? {});
      return json({ replaced: true });
    }
    return json({ error: { code: "not_found", message: "no such route" } }, 404);
  }) as typeof fetch;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** The REAL hook + the REAL card, wired exactly as `AppShell` wires them. */
async function mount(opts: {
  active: boolean;
  recheckMs?: number;
  /** A host's own wire, when the test is about one — the desktop's seam. */
  transport?: import("../app/shell/ProfileImportCard.js").ProfileImportTransport;
}): Promise<void> {
  const { ProfileImportCard, useProfileImport } = await import("../app/shell/ProfileImportCard.js");

  function Probe(): React.ReactElement | null {
    const state = useProfileImport(opts.active, [MB], opts.transport, opts.recheckMs);
    if (!state.offer) return h("div", { className: "no-card" });
    return h(ProfileImportCard as never, {
      offer: state.offer,
      phase: state.phase,
      onImport: state.importNow,
      onNotNow: state.notNow,
      onAcknowledge: state.acknowledge,
    } as never);
  }

  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
    children: h(Probe),
  });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const card = (): HTMLElement | null => host!.querySelector(".pfi-card");

const button = (label: string): HTMLButtonElement => {
  const el = Array.from(host!.querySelectorAll("button"))
    .find((b) => (b.textContent ?? "").trim() === label);
  if (!el) throw new Error(`no button labelled "${label}"`);
  return el;
};

const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  calls = [];
  declined = [];
  replacedBodies = [];
  applyRefusal = null;
  candidate = {
    state: "found",
    fingerprint: FINGERPRINT,
    updatedAt: "2026-08-10T09:00:00.000Z",
    producer: { kind: "local", version: "0.9.3" },
    counts: { screener: 142, rules: 8, notifyRules: 0, tags: 3, awayResponder: false },
  };
  applied = {
    imported: { screener: 142, rules: 8, notifyRules: 0, tags: 3, awayResponder: false },
    skippedRules: 0,
    seq: 41,
  };
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
});

describe("the restore card", () => {
  it("a found document renders the offer: the counts in words, the mailbox, both buttons", async () => {
    await mount({ active: true });
    const el = card();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("We found your ohmail settings on this mailbox");
    expect(el!.textContent).toContain("mila@example.com");
    // The counts, human-readable — what will import, said before anything can be pressed.
    expect(el!.textContent).toContain("142 screener decisions");
    expect(el!.textContent).toContain("8 rules");
    expect(el!.textContent).toContain("3 tags");
    // Zero sections say nothing: no "0 notification choices", no bare away-reply claim.
    expect(el!.textContent).not.toContain("notification");
    expect(el!.textContent).not.toContain("away reply");
    // What pressing will do — and not do — is on the card.
    expect(el!.textContent).toContain("nothing else in your mail changes");
    expect(button("Import settings")).toBeTruthy();
    expect(button("Not now")).toBeTruthy();
  });

  /**
   * ── WHAT NOT ANSWERING LEAVES IN THE MAILBOX IS ON THE CARD (QAO-OWN-PUBLISH-BESIDE-A-RETAINED-HOLD)
   * While this question stands unanswered, the organizer publishes its OWN settings beside the found
   * document and keeps that document in the mailbox until the person answers ("Not now" keeps it:
   * `organizer-profile-worker.test.ts`); beside a copy under its own install id it publishes nothing
   * until then. The card says the found settings stay. The needle is the rendered card, from the
   * catalogue's own sentence; the literal pins the claim, so a reword that drops it reddens.
   */
  it("the card says what NOT answering leaves: the found settings stay in the mailbox until you choose", async () => {
    await mount({ active: true });
    const el = card();
    expect(el).not.toBeNull();
    const willDo = (messages as unknown as { profileImport: { willDo: string } }).profileImport.willDo;
    expect(willDo, "the catalogue's sentence no longer says what not answering leaves in the mailbox")
      .toContain("Until you choose, these settings stay in the mailbox.");
    expect(el!.textContent, "the cost sentence is in the catalogue and not on the card").toContain(willDo);
    expect(el!.textContent, "the card says an imported screen-out marks mail read").not.toMatch(/marked read/i);
  });

  it("the card says what routing does until the answer: admitted senders stay, other new senders are screened", async () => {
    // Measured on 0.25.1: the hold covers only the senders the found settings let through, and the card
    // is the one place that says so. The needle is the rendered card, from the catalogue's sentence.
    await mount({ active: true });
    const sentence = (messages as unknown as { profileImport: { routingWhileOpen: string } }).profileImport.routingWhileOpen;
    expect(sentence).toBe(
      "Until you answer, mail from senders these settings let through stays where it arrived; other new senders are screened as usual.");
    expect(card()!.textContent).toContain(sentence);
  });

  it("Import sends the exact fingerprint shown and becomes the confirmation; Done dismisses", async () => {
    await mount({ active: true });
    await click(button("Import settings"));

    const post = calls.find((c) => c.method === "POST" && c.path === `/mailboxes/${MB.id}/profile-import`);
    expect(post, "the apply must carry the fingerprint the card was built from").toBeTruthy();
    expect(post!.body).toEqual({ fingerprint: FINGERPRINT });

    const el = card();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Your settings are back.");
    expect(el!.textContent).toContain("142 screener decisions");

    await click(button("Done"));
    expect(card()).toBeNull();
  });

  it("skipped rules are disclosed on the confirmation, never silently dropped", async () => {
    applied = { ...applied, skippedRules: 2 };
    await mount({ active: true });
    await click(button("Import settings"));
    expect(card()!.textContent).toContain("2 rules couldn't be imported.");
  });

  it("Not now records the durable dismissal and the card leaves — and stays gone on the next look", async () => {
    await mount({ active: true });
    await click(button("Not now"));
    expect(declined).toEqual([{ fingerprint: FINGERPRINT }]);
    expect(card()).toBeNull();
    // Nothing was applied on the way out.
    expect(calls.some((c) => c.method === "POST" && c.path === `/mailboxes/${MB.id}/profile-import`)).toBe(false);

    // A fresh tab asks again; the server, holding the durable answer, says none — no card.
    if (root) await act(async () => { root!.unmount(); });
    root = null; host?.remove(); host = null;
    await mount({ active: true });
    expect(card()).toBeNull();
  });

  it("a NEWER document gets its sentence and NO import button; dismissing names the version", async () => {
    candidate = { state: "newer", v: 2 };
    await mount({ active: true });
    const el = card();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("newer version of ohmail");
    expect(el!.textContent).toContain("Update ohmail");
    // No path to a lossy import exists on this card.
    expect(Array.from(host!.querySelectorAll("button")).map((b) => b.textContent?.trim()))
      .not.toContain("Import settings");
    await click(button("Dismiss"));
    expect(declined).toEqual([{ v: 2 }]);
    expect(card()).toBeNull();
  });

  it("a refused apply keeps the offer and shows the SERVER's sentence — the decision survives", async () => {
    applyRefusal = {
      status: 409, code: "profile_changed",
      message: "The saved settings changed since you looked. Review them again before importing.",
    };
    await mount({ active: true });
    await click(button("Import settings"));
    const el = card();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("The saved settings changed since you looked.");
    // Both buttons are still there: try again, or keep local.
    expect(button("Import settings").disabled).toBe(false);
    expect(button("Not now").disabled).toBe(false);
  });

  it("an authoritative `none` on a later look clears a resting offer — another device answered", async () => {
    await mount({ active: true, recheckMs: 25 });
    expect(card()).not.toBeNull();
    // Another device imports or declines; the server's next answer is `none`, and a card left
    // standing would offer an Import button for a question that is already answered.
    candidate = { state: "none" };
    await act(async () => { await new Promise((r) => setTimeout(r, 90)); });
    expect(card(), "an answered question must take its card with it").toBeNull();
  });

  it("an answer this build does not recognise renders NOTHING — the tolerant-reader rule", async () => {
    // The shape a catch-all mock, a misbehaving proxy, or a DIFFERENT server build answers:
    // 200 with a body that is not one of the three states. The claim "your settings are
    // waiting" may only come from a recognised answer — anything else is `none`, never a card
    // and NEVER a render crash that would take the whole shell down with it.
    candidate = {};
    await mount({ active: true });
    expect(card()).toBeNull();
    // …and a half-recognised `found` (no counts, no fingerprint) is equally not an offer.
    candidate = { state: "found" };
    if (root) await act(async () => { root!.unmount(); });
    root = null; host?.remove(); host = null;
    await mount({ active: true });
    expect(card()).toBeNull();
  });

  it("inactive ⇒ nothing renders AND nothing is asked", async () => {
    // Primed with a found document on purpose: if the gate is ever mutated away, the check
    // fires, the card appears, and both assertions go red rather than vacuously green.
    await mount({ active: false });
    expect(card()).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("the mailbox set is the scope of every offer", () => {
  /** The real hook + card again, with the mailbox LIST swappable mid-flight — the desktop's
   *  door switch (a new engine, a new account's ids, the same mounted shell) and the browser's
   *  mailbox removal are both exactly this: the set changes under a standing offer. */
  type Box = { id: string; address: string; status?: string; legacyStandDown?: boolean };
  async function mountList(list: Box[]): Promise<(next: Box[]) => Promise<void>> {
    const { ProfileImportCard, useProfileImport } = await import("../app/shell/ProfileImportCard.js");
    function ListProbe({ boxes }: { boxes: Box[] }) {
      const state = useProfileImport(true, boxes, undefined, 60_000);
      if (!state.offer) return h("div", { className: "no-card" });
      return h(ProfileImportCard as never, {
        offer: state.offer,
        phase: state.phase,
        onImport: state.importNow,
        onNotNow: state.notNow,
        onAcknowledge: state.acknowledge,
      } as never);
    }
    const render = async (boxes: Box[]): Promise<void> => {
      const el = h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
        children: h(ListProbe, { boxes }),
      });
      if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
      await act(async () => { root!.render(el); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await render(list);
    return render;
  }

  it("a mailbox that leaves the account takes its card with it, and the next mailbox's own question is reachable", async () => {
    // The stale-offer trap: the check loop walks the CURRENT list, so an offer for a mailbox
    // that VANISHED from it was never re-checked and never retired — it stayed first in the
    // queue, its buttons addressed the old id (a 404 through a switched desktop engine), and
    // the real offer behind it was unreachable until a reload.
    const swap = await mountList([MB]);
    expect(card()!.textContent).toContain(MB.address);

    await swap([MB2]);
    expect(card(), "the new mailbox's own offer must be on the card").not.toBeNull();
    expect(card()!.textContent).toContain(MB2.address);
    expect(card()!.textContent).not.toContain(MB.address);
  });

  /* the roster still lists a removed mailbox's tombstone, so its card stayed on
     screen. Mutation: scope on `mailboxes` instead of the live rows and the first case reds. */
  it("a REMOVED mailbox takes its card with it — the roster still lists its tombstone", async () => {
    const swap = await mountList([MB]);
    expect(card()!.textContent).toContain(MB.address);
    await swap([{ ...MB, status: "disabled" }]);
    expect(card(), "the removed mailbox's settings card is still on screen").toBeNull();
  });

  it("…and the next mailbox's own question is reachable behind the removed one", async () => {
    const swap = await mountList([MB]);
    await swap([{ ...MB, status: "disabled" }, MB2]);
    expect(card()!.textContent).toContain(MB2.address);
    expect(card()!.textContent).not.toContain(MB.address);
  });

  it("…while a stand-down an older engine reports as `disabled` keeps its card", async () => {
    const swap = await mountList([MB]);
    await swap([{ ...MB, status: "disabled", legacyStandDown: true }]);
    expect(card()!.textContent).toContain(MB.address);
  });

  it("an UNKNOWN list is not an empty one — a probe failure must not take a standing card down", async () => {
    // `null` means "cannot see the account's mailboxes right now", and the away notice's rule
    // holds here too: never retract a true claim on a guess. Only a real list prunes.
    const swap = await mountList([MB]);
    expect(card()).not.toBeNull();
    await swap(null as never);
    expect(card(), "a transient probe failure emptied the card").not.toBeNull();
    expect(card()!.textContent).toContain(MB.address);
  });
});

describe("a removed mailbox has no settings check", () => {
  /* VTF2-02: a mailbox removed from a desktop kept its check alive — a 502 every five minutes,
     117 in one day. A removal leaves the row `disabled` in `GET /mailboxes`; the hook drops it. */
  type Box = { id: string; address: string; status?: string };
  const asks = (id: string): number =>
    calls.filter((c) => c.method === "GET" && c.path === `/mailboxes/${id}/profile-import`).length;

  async function mountBoxes(list: Box[], recheckMs: number): Promise<(next: Box[]) => Promise<void>> {
    const { ProfileImportCard, useProfileImport } = await import("../app/shell/ProfileImportCard.js");
    function BoxProbe({ boxes }: { boxes: Box[] }) {
      const state = useProfileImport(true, boxes, undefined, recheckMs);
      if (!state.offer) return h("div", { className: "no-card" });
      return h(ProfileImportCard as never, {
        offer: state.offer, phase: state.phase,
        onImport: state.importNow, onNotNow: state.notNow, onAcknowledge: state.acknowledge,
      } as never);
    }
    const render = async (boxes: Box[]): Promise<void> => {
      const el = h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
        children: h(BoxProbe, { boxes }),
      });
      if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
      await act(async () => { root!.render(el); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await render(list);
    return render;
  }
  const beats = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 120)); }); };

  it("a removal takes the card down, and no beat asks about that mailbox again", async () => {
    const swap = await mountBoxes([MB], 25);
    expect(card()).not.toBeNull();
    await swap([{ ...MB, status: "disabled" }]);
    expect(card(), "the removed mailbox kept its card").toBeNull();
    const before = asks(MB.id);
    await beats();
    expect(asks(MB.id), "a beat asked about a removed mailbox").toBe(before);
  });

  it("CONTROL: the same beat asks a listed mailbox again", async () => {
    await mountBoxes([MB], 25);
    const before = asks(MB.id);
    await beats();
    expect(asks(MB.id)).toBeGreaterThan(before);
  });

  it("a mailbox listed as removed is never asked, and Settings lists no row for it", async () => {
    await mountBoxes([{ ...MB, status: "disabled" }, MB2], 60_000);
    expect(asks(MB.id)).toBe(0);
    expect(asks(MB2.id), "the live mailbox beside it is still asked").toBe(1);
    if (root) await act(async () => { root!.unmount(); });
    root = null; host?.remove(); host = null;
    candidate = { ...candidate, state: "declined" };
    const { SavedProfileSection } = await import("../app/shell/ProfileImportCard.js");
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
        children: h(SavedProfileSection, { mailboxes: [{ ...MB, status: "disabled" }] }),
      }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(asks(MB.id)).toBe(0);
    expect(host.textContent ?? "").not.toContain("Settings saved on");
  });
});

describe("a host's own transport — the desktop's seam, driven where it can be driven", () => {
  /** A transport that answers from the test's own state and records every call it carries. */
  function hostWire(overrides: Partial<import("../app/shell/ProfileImportCard.js").ProfileImportTransport> = {}) {
    const carried: Array<{ verb: string; args: unknown[] }> = [];
    const wire: import("../app/shell/ProfileImportCard.js").ProfileImportTransport = {
      candidate: async (id) => { carried.push({ verb: "candidate", args: [id] }); return candidate as never; },
      apply: async (id, fp) => { carried.push({ verb: "apply", args: [id, fp] }); return applied as never; },
      status: async (id, fp) => { carried.push({ verb: "status", args: [id, fp] }); return { state: "importing", fingerprint: fp }; },
      decline: async (id, subject) => { carried.push({ verb: "decline", args: [id, subject] }); return { dismissed: true }; },
      replace: async (id, fp) => { carried.push({ verb: "replace", args: [id, fp] }); return { replaced: true }; },
      ...overrides,
    };
    return { wire, carried };
  }

  it("an injected transport carries every call, and nothing reaches the Cloud client", async () => {
    // BOOBY TRAP: with a host wire in hand, a single request through the Cloud client is a
    // desktop window opening a socket — the exact thing its CSP and offline guard forbid.
    globalThis.fetch = (async () => {
      throw new Error("the injected transport was bypassed — this must never reach fetch");
    }) as typeof fetch;
    const { wire, carried } = hostWire();
    await mount({ active: true, transport: wire });
    expect(card()).not.toBeNull();
    await click(button("Import settings"));
    expect(carried).toEqual([
      { verb: "candidate", args: [MB.id] },
      { verb: "apply", args: [MB.id, FINGERPRINT] },
    ]);
  });

  it("an injected transport's refusal reaches the card as its own sentence — the engine's words, not the generic line", async () => {
    // The host wire's contract (`local-profile-import.ts`): a rejection's message IS the
    // engine's sentence, fit to show. Without this branch a desktop 409 ("the settings changed,
    // review again") would collapse into the generic retry line — a worse instruction than the
    // one the engine wrote.
    const said = "The saved settings changed since you looked. Review them again before importing.";
    const { wire } = hostWire({ apply: async () => { throw new Error(said); } });
    await mount({ active: true, transport: wire });
    await click(button("Import settings"));
    expect(card()!.textContent).toContain(said);
    // The decision survives the refusal: the offer and both buttons are still there.
    expect(button("Import settings")).toBeDefined();
  });
});

describe("Settings → Mailboxes: a declined document, with Import and Replace", () => {
  async function mountRow(transport?: import("../app/shell/ProfileImportCard.js").ProfileImportTransport): Promise<void> {
    const { SavedProfileSection } = await import("../app/shell/ProfileImportCard.js");
    const el = h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
      children: h(SavedProfileSection, { mailboxes: [MB], ...(transport ? { transport } : {}) }),
    });
    if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
    await act(async () => { root!.render(el); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  beforeEach(() => {
    candidate = { ...candidate, state: "declined" };
  });

  it("names the mailbox, what the document holds, and what Replace will do before it is pressed", async () => {
    await mountRow();
    const text = host!.textContent ?? "";
    expect(text).toContain("Settings saved on mila@example.com");
    expect(text).toContain("142 screener decisions");
    expect(text).toContain("You chose Not now, so they stay in the mailbox");
    expect(text).toContain("Saving replaces 142 screener decisions, 8 rules, and 3 tags in the mailbox");
    expect(text).toContain("within a few minutes");
    expect(button("Import settings")).toBeTruthy();
    expect(button("Save this ohmail's settings to the mailbox")).toBeTruthy();
  });

  it("Replace posts the exact fingerprint and says when it lands; the buttons go", async () => {
    await mountRow();
    await click(button("Save this ohmail's settings to the mailbox"));
    expect(replacedBodies).toEqual([{ fingerprint: FINGERPRINT }]);
    expect(host!.textContent).toContain("This ohmail's settings go to the mailbox within a few minutes.");
    expect(() => button("Import settings")).toThrow();
  });

  it("Import applies the exact fingerprint and confirms what arrived", async () => {
    await mountRow();
    await click(button("Import settings"));
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { method: "POST", path: `/mailboxes/${MB.id}/profile-import`, body: { fingerprint: FINGERPRINT } },
    ]);
    expect(host!.textContent).toContain("Your settings are back.");
  });

  it("a refused replace keeps both buttons, with the host's own sentence above them", async () => {
    const said = "Another install organizes this mailbox.";
    await mountRow({
      candidate: async () => candidate as never,
      apply: async () => applied as never,
      status: async () => { throw new Error("not asked"); },
      decline: async () => ({ dismissed: true }),
      replace: async () => { throw new Error(said); },
    });
    await click(button("Save this ohmail's settings to the mailbox"));
    expect(host!.textContent).toContain(said);
    expect(button("Save this ohmail's settings to the mailbox")).toBeTruthy();
    expect(button("Import settings")).toBeTruthy();
  });

  it("an open question and a resting mailbox both render no row, and the card offers nothing for a declined one", async () => {
    candidate = { ...candidate, state: "found" };
    await mountRow();
    expect(host!.textContent).toBe("");
    await act(async () => { root!.unmount(); });
    host?.remove(); root = null; host = null;
    candidate = { ...candidate, state: "declined" };
    await mount({ active: true });
    expect(card(), "a declined document must never return as the card").toBeNull();
  });
});

describe("the doorbell: a find is asked for on the drain that carries it", () => {
  /** A transport whose candidate answers are HELD until the test releases them, in order. */
  function heldWire() {
    const pending: Array<(v: unknown) => void> = [];
    const asked: string[] = [];
    let declineRelease: (() => void) | null = null;
    const wire: import("../app/shell/ProfileImportCard.js").ProfileImportTransport = {
      candidate: (id) => { asked.push(id); return new Promise((r) => { pending.push(r as (v: unknown) => void); }) as never; },
      apply: async () => applied as never,
      status: async () => { throw new Error("not asked"); },
      decline: () => new Promise((r) => { declineRelease = () => r({ dismissed: true }); }),
      replace: async () => ({ replaced: true }),
    };
    const flush = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    return {
      wire, asked,
      answer: async (v: unknown) => { const r = pending.shift(); if (!r) throw new Error("no ask is waiting"); await act(async () => { r(v); }); await flush(); },
      declined: async () => { if (!declineRelease) throw new Error("no decline is waiting"); const r = declineRelease; declineRelease = null; await act(async () => { r(); }); await flush(); },
    };
  }

  /** The real hook + card with the doorbell as a prop; the beat is an hour, so only a ring can ask. */
  async function mountBell(wire: import("../app/shell/ProfileImportCard.js").ProfileImportTransport): Promise<(bell: number | null) => Promise<void>> {
    const { ProfileImportCard, useProfileImport } = await import("../app/shell/ProfileImportCard.js");
    function BellProbe({ bell }: { bell: number | null }) {
      const state = useProfileImport(true, [MB], wire, 60 * 60 * 1000, bell);
      if (!state.offer) return h("div", { className: "no-card" });
      return h(ProfileImportCard as never, {
        offer: state.offer, phase: state.phase,
        onImport: state.importNow, onNotNow: state.notNow, onAcknowledge: state.acknowledge,
      } as never);
    }
    const render = async (bell: number | null): Promise<void> => {
      const el = h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
        children: h(BellProbe, { bell }),
      });
      if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
      await act(async () => { root!.render(el); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await render(7);
    return render;
  }

  it("a ring re-asks at once, whatever the beat says; the same doorbell asks nothing", async () => {
    const w = heldWire();
    const ring = await mountBell(w.wire);
    expect(w.asked).toEqual([MB.id]);
    await w.answer({ state: "none" });
    await ring(7);
    expect(w.asked, "a re-render with an unmoved doorbell asked again").toHaveLength(1);
    await ring(8);
    expect(w.asked, "the ring did not re-ask").toHaveLength(2);
    await w.answer(candidate);
    expect(card(), "the ring's answer did not reach the card").not.toBeNull();
  });

  it("a ring that meets an ask in flight is OWED: the ask runs again once the first settles", async () => {
    const w = heldWire();
    const ring = await mountBell(w.wire);
    await ring(8); // the find rang while the mount's ask, taken before it, was still out
    expect(w.asked).toHaveLength(1);
    await w.answer({ state: "none" });
    expect(w.asked, "the ring was dropped behind the ask it met").toHaveLength(2);
    await w.answer(candidate);
    expect(card()).not.toBeNull();
  });

  it("an ask that left before Not now was answered applies nothing: the dismissed card stays gone", async () => {
    const w = heldWire();
    const ring = await mountBell(w.wire);
    await w.answer(candidate);
    await click(button("Not now"));
    await ring(8); // a ring while the decline is still out: the re-ask leaves before the answer lands
    expect(w.asked).toHaveLength(2);
    await w.declined();
    expect(card()).toBeNull();
    await w.answer(candidate); // the stale ask comes back carrying the question already answered
    expect(card(), "an ask older than the answer brought the dismissed card back").toBeNull();
  });
});

describe("the shell wiring, pinned by source", () => {
  const shell = read("shell/AppShell.tsx");

  /* Re-decided (HOST-CLIENT-DECLINED-SETTINGS-HAS-NO-ROW): the SHELL reads the declined rows, so
     the pane exists on a surface with no mailbox node while one stands. */
  it("the Mailboxes pane carries the declined rows over the same transport, withheld on the demo", () => {
    expect(shell).toContain("<SavedProfileSection rows={profileImportOffer.declined} transport={profileImportTransport} />");
    expect(shell).toContain("savedSettingsSection={demo || profileImportOffer.declined.length === 0 ? undefined : (");
    // The rows are the card's own answers, never a second request (`useProfileImport`'s `declined`).
    const hook = sliceOfDeclaration(read("shell/ProfileImportCard.tsx"), "useProfileImport");
    expect(hook).toContain("const saved = asDeclined(dto);");
    expect(hook).not.toContain("useSavedProfiles(");
    const view = read("views/SettingsView.tsx");
    expect(view).toContain('{shown === "mailboxes" ? savedSettingsSection : null}');
  });

  it("the shell holds ONE import state, gated on the demo alone, on the host's wire when there is one", () => {
    expect(shell).toMatch(/const profileImportOffer = useProfileImport\(!demo, facts, profileImportTransport, undefined, profileDoorbell\);/);
  });

  it("the shell hands the hook the mirror's doorbell, re-read with every derived version", () => {
    const decl = sliceOfDeclaration(shell, "profileDoorbell");
    expect(decl).toContain("() => settingsDoorbell(engine.read()),");
    expect(decl).toContain("[engine, derived],");
  });

  it("the card floats over the stage, above the seed review, and renders only on a real offer", () => {
    const stage = /<main className="stage"[\s\S]*?\{profileImportOffer\.offer \? \(\s*<ProfileImportCard/.exec(shell);
    expect(stage, "the card must be mounted inside the stage, gated on the offer").not.toBeNull();
    expect(shell.indexOf("profileImportOffer.offer ? ("))
      .toBeLessThan(shell.indexOf("{seedOwed ? ("));
  });
});

describe("a press the organizer finishes — the card says importing, then the result, each once", () => {
  /** A wire whose confirm answers 202 and whose status the test settles by hand. */
  function handoverWire(reason: "slow" | "unreachable" = "slow") {
    const statusAsked: string[] = [];
    let status: Record<string, unknown> = { state: "importing", fingerprint: FINGERPRINT };
    const wire: import("../app/shell/ProfileImportCard.js").ProfileImportTransport = {
      candidate: async () => candidate as never,
      apply: async (_id, fp) => ({ state: "importing", fingerprint: fp, reason }) as never,
      status: async (_id, fp) => { statusAsked.push(fp); return status as never; },
      decline: async () => ({ dismissed: true }),
      replace: async () => ({ replaced: true }),
    };
    return { wire, statusAsked, settle: (v: Record<string, unknown>) => { status = v; } };
  }

  async function mountRinging(wire: import("../app/shell/ProfileImportCard.js").ProfileImportTransport): Promise<(bell: number) => Promise<void>> {
    const { ProfileImportCard, useProfileImport } = await import("../app/shell/ProfileImportCard.js");
    function Probe({ bell }: { bell: number }) {
      const state = useProfileImport(true, [MB], wire, 60 * 60 * 1000, bell);
      if (!state.offer) return h("div", { className: "no-card" });
      return h(ProfileImportCard as never, {
        offer: state.offer, phase: state.phase,
        onImport: state.importNow, onNotNow: state.notNow, onAcknowledge: state.acknowledge,
      } as never);
    }
    const render = async (bell: number): Promise<void> => {
      const el = h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-17T12:00:00.000Z"),
        children: h(Probe, { bell }),
      });
      if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
      await act(async () => { root!.render(el); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await render(1);
    return render;
  }

  it("a 202 shows the importing line and keeps the buttons from a second press; the ring brings the result", async () => {
    const w = handoverWire();
    const ring = await mountRinging(w.wire);
    await click(button("Import settings"));
    expect(card()!.textContent).toContain(messages.profileImport.importingSlow);
    expect(button("Importing…").disabled).toBe(true);
    expect(card()!.textContent, "a 202 read as a failure").not.toContain("That didn't work.");
    w.settle({ state: "imported", imported: { screener: 142, rules: 8, notifyRules: 0, tags: 3, awayResponder: false }, skippedRules: 0 });
    await ring(2);
    expect(host!.textContent).toContain("Your settings are back.");
    expect(w.statusAsked.every((fp) => fp === FINGERPRINT)).toBe(true);
  });

  it("an unreachable mailbox says so, not 'slowly'", async () => {
    const w = handoverWire("unreachable");
    await mountRinging(w.wire);
    await click(button("Import settings"));
    expect(card()!.textContent).toContain(messages.profileImport.importingUnreachable);
  });

  it("the organizer's refusal is the server's sentence, said ONCE — no 'Try again.' after it", async () => {
    const w = handoverWire();
    const ring = await mountRinging(w.wire);
    await click(button("Import settings"));
    const said = "The mailbox did not answer for ten minutes, so the settings were not imported.";
    w.settle({ state: "refused", reason: "timed_out", message: said });
    await ring(2);
    const alert = host!.querySelector(".pfi-error")!.textContent!;
    expect(alert).toBe(`That didn't work. ${said}`);
    expect(alert.match(/Try again\./g), "the sentence was doubled").toBeNull();
  });

  it("CONTROL: a failure with no server sentence keeps the generic line and its one retry", async () => {
    // An injected transport that can say nothing true rejects with an empty message (the contract
    // on `ProfileImportTransport`), which is the one case the card composes its own line for.
    await mount({ active: true, transport: {
      candidate: async () => candidate as never,
      apply: async () => { throw new Error(""); },
      status: async () => { throw new Error("not asked"); },
      decline: async () => ({ dismissed: true }),
      replace: async () => ({ replaced: true }),
    } });
    await click(button("Import settings"));
    expect(host!.querySelector(".pfi-error")!.textContent).toBe("That didn't work. Something went wrong. Try again.");
  });
});
