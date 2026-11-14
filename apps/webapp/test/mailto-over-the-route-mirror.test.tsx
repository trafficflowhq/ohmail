/** @vitest-environment jsdom */
/**
 * AN OS `mailto:` CLICK WINS THE COMMIT IT SHARES WITH A ROUTE↔OPEN MIRROR WRITE.
 *
 * Both write the hash: the mirror reflects the open state into the bar (`reflectMessage`, in
 * `shell-open-state.ts`), and the desktop's `mailtoDraft` effect navigates to the composer
 * (`go("compose")`, in `shell-compose.ts`). In one React commit the LAST writer owns the bar, so
 * the order of the two hook calls decides which. `useShellCompose` is called below
 * `useShellOpenState` (ARCH-022, the L3 ruling) — mirror, then mailto — and the explicit action
 * stands. The old order let the mirror swallow the click, and it is the red arm below.
 *
 * SORTED BY THE OLDER TESTS' CHECKLIST (share write-1): today's `AppShell` and its open-state hook leave with today's
 * shell. The two hook-order censuses over `AppShell.tsx` left with it (the new shell has one address door, which only
 * the frame writes: `frame/writing-mount.test.tsx` holds a link's place standing); the census of where the mailto
 * effect lives reads its caller now, `WritingMount.tsx`. The mail-link cases are read over Write's letter in the new
 * shell (the region "New message", its line "Subject", its text "Message", its verbs "Send or discard"), and what
 * the composition says is read where it is said, by role (status and alert); the cases that open a letter from
 * Drafts wait for Drafts.
 */
import type { EngineDraft } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { MemoryMirrorStore, type MirrorStore, type SyncChange } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { go, parseHash, reflectMessage } from "../app/shell/routing";
import { EMPTY_COMPOSE, markComposeRowHolds, resetComposerForTest, writeComposeDraft, writeComposeRow } from "@ohmail/app-logic/writing/compose";
import { holdsSig } from "@ohmail/app-logic/writing/compose-autosave";
import { sendPendingInDurableOutbox } from "@ohmail/app-logic/writing/mail-send";
import { RESTART_FLUSH_MS } from "@ohmail/app-logic/doors/app-update";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";
import { composeLine, composeSend, composeSubject, composerOn, letter, navigate, rounds, toasts } from "./_handoff-steps.js";
import { resetStorageOwnerForTest, setStorageOwner, storageOwner } from "@ohmail/app-logic/storage/storage-owner";

/** Whose keys the shell keeps and this file reads: one account, named before the shell mounts. */
const OWNER = "acc-mail-link";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shellDir = resolve(process.cwd(), "apps/webapp/app/shell");
const groundDir = resolve(process.cwd(), "packages/app/src/mail/ground");
const read = (name: string): string => readFileSync(resolve(shellDir, name), "utf8");

/* WRITE's LETTER in the new shell, by role and name (share write-1; today's `.view-compose`, `#compose-subject`,
   `.rte-surface` and its send row). */
const LETTER = '[role="region"][aria-label="New message"]';
const letterSubject = (el: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null =>
  el.querySelector<HTMLTextAreaElement>(`${LETTER} textarea[aria-label="Subject"], ${LETTER} input[aria-label="Subject"]`);
const letterText = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(`${LETTER} [role="textbox"][aria-label="Message"]`);
const letterSend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(`${LETTER} [role="toolbar"][aria-label="Send or discard"] button`)]
    .find((b) => b.getAttribute("aria-label") === "Send" || (b.textContent ?? "").trim() === "Send");
/** What the app says, wherever it says it: every status and alert on the page (today's toasts among them). */
const said = (): string =>
  [...document.querySelectorAll('[role="status"], [role="alert"]')].map((n) => n.textContent ?? "").join(" | ");
/** A line typed as a person types it: the native setter of its own kind, then the input event. */
async function setLine(field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = field instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * The two writers as the shell registers them: one effect per hook, in the order the hooks are
 * called. `mirror` is the real `reflectMessage` over a real route; `mailto` is the real `go`.
 */
function Both({ order }: { order: "mirror-then-mailto" | "mailto-then-mirror" }) {
  const mirror = (): void => { reflectMessage(parseHash("#/ohbox"), "m-1"); };
  const mailto = (): void => { go("compose"); };
  const [first, second] = order === "mirror-then-mailto" ? [mirror, mailto] : [mailto, mirror];
  React.useEffect(first, []);
  React.useEffect(second, []);
  return null;
}

async function hashAfter(order: "mirror-then-mailto" | "mailto-then-mirror"): Promise<string> {
  window.location.hash = "#/ohbox";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(h(Both, { order })); });
  const hash = window.location.hash;
  await act(async () => { root.unmount(); });
  host.remove();
  return hash;
}

describe("a mailto: click and a mirror write in one commit", () => {
  it("leaves the compose hash standing in the shipped order", async () => {
    expect(await hashAfter("mirror-then-mailto")).toBe("#/compose");
  });

  /* THE RED CONTROL, RUN RATHER THAN DESCRIBED: the old order, where the mirror's write lands
     last and the person's click is gone from the bar. If this ever reads `#/compose` the arm
     above has stopped measuring anything. */
  it("loses it in the old order — the mirror writes last", async () => {
    const hash = await hashAfter("mailto-then-mirror");
    expect(hash).not.toBe("#/compose");
    expect(hash).toBe("#/ohbox/m/m-1");
  });
});

describe("the order the shell registers them in", () => {
  /* And the two effects are in the two frames the order is about — a mailto effect left behind
     in `AppShell.tsx` would be registered above the open state, whatever the call order says. */
  /* MAILTO-PARSER-HAS-THREE-HOMES: the one parser's draft reaches the composer whole — every
     surface carries to, cc, bcc, subject and body (the desktop's and the phone's halves are theirs). */
  it("seeds all five fields of the parsed draft", () => {
    const src = read("../../../../packages/app-logic/src/writing/shell-compose.ts");
    for (const f of ["to: chips(mailtoDraft.to)", "cc: chips(mailtoDraft.cc)", "bcc: chips(mailtoDraft.bcc)", "subject: mailtoDraft.subject", "body: mailtoDraft.body"]) {
      expect(src, `the seeder drops ${f}`).toContain(f);
    }
  });

  /* RE-POINTED BY PATH (share write-1): the composition's caller is `WritingMount.tsx` now; today's open-state hook,
     whose mirror write the case also read, left with today's shell (its row RETIRED: the frame's one address door). */
  it("holds the mailto effect in shell-compose.ts, not in the composition's caller", () => {
    /* The effect's own BODY, not the file: `writeTo` navigates to the composer too, so a file-wide
       `toContain` would read its copy and pass over a mailto effect that had stopped navigating. */
    const compose = read("../../../../packages/app-logic/src/writing/shell-compose.ts");
    const deps = "[mailtoDraft, autosave, go, onMailtoDraftSeeded]";
    const end = compose.indexOf(deps);
    expect(end, "the mailto effect's dependency array is not in shell-compose.ts").toBeGreaterThan(0);
    const start = compose.lastIndexOf("useEffect(() => {", end);
    expect(compose.slice(start, end), "the mailto effect no longer navigates to the composer")
      .toContain('go("compose");');
    expect(readFileSync(resolve(groundDir, "WritingMount.tsx"), "utf8")).toContain("useShellCompose(");
    expect(readFileSync(resolve(groundDir, "WritingMount.tsx"), "utf8")).not.toContain(deps);
  });
});

/* ── A MAIL LINK OVER WORDS THE COMPOSER HOLDS ───────────────────────────────────────────────
   The link's letter replaces what is on screen only once those words are on the account: saved
   first, never asked, and a link whose save was refused leaves them where they are. */
describe("a mail link over a letter being written", () => {
  const LINK = { to: ["lena@example.invalid"], cc: [], bcc: [], subject: "Hello from a link", body: "" };
  const subject = (s: DraftShell): HTMLInputElement | HTMLTextAreaElement | null => letterSubject(s.el);
  const rows = (s: DraftShell): string[] => s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft")
    .map((d) => `${d.subject}|${(d.body ?? "").trim()}`);
  async function setSubject(s: DraftShell, value: string): Promise<void> {
    await setLine(subject(s)!, value);
  }
  /** Rows on the account at the moment the composer first shows the link's letter. */
  async function rowsWhenLinkShows(s: DraftShell): Promise<string[]> {
    await waitFor(() => subject(s)?.value === LINK.subject, "the link's letter", 240);
    return rows(s);
  }
  beforeEach(() => {
    try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
    setStorageOwner(OWNER);
    stubDom();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  });
  afterEach(async () => { await unmountAll(); resetComposerForTest(); resetStorageOwnerForTest(); });

  it("words typed inside the pause are saved as a draft before the link's letter opens", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], []);
    await navigate("#/compose");
    await waitFor(() => letterText(s.el) != null, "the composer");
    await settleEditor();
    await setSubject(s, "Notes from the meeting");
    await act(async () => { typeInto(letterText(s.el)!, "We agreed on three things."); });
    await s.mailto.open(LINK);
    expect(await rowsWhenLinkShows(s)).toEqual(["Notes from the meeting|We agreed on three things."]);
    expect(s.mailto.seeded).toBe(1);
  }, 60_000);

  it("a link that starts the app saves the letter the last session left before it opens", async () => {
    writeComposeDraft({ ...EMPTY_COMPOSE, subject: "Left unsaved last time", body: "Words only this buffer holds." }, storageOwner());
    const s = await mountShell("#/ohbox", [message("m1")], [], { mailto: LINK });
    expect(await rowsWhenLinkShows(s)).toEqual(["Left unsaved last time|Words only this buffer holds."]);
    expect(window.location.hash).toBe("#/compose");
  }, 60_000);

  it("a save the account refuses keeps the words on screen, says so, and the link is taken once", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter("d-x", "Plans for Friday", "Shall we meet at noon?")]);
    await composerOn(s, "d-x", "Plans for Friday");
    s.refuseSave.add("d-x");
    await setSubject(s, "Plans for Friday, changed");
    await s.mailto.open(LINK);
    await waitFor(() => toasts().includes(en.drafts.reopenBlockedUnsaved), "the refusal said", 240);
    await navigate("#/ohbox");
    await rounds(4);
    await navigate("#/compose");
    await rounds(20);
    expect({ shown: subject(s)?.value, seeded: s.mailto.seeded }).toEqual({ shown: "Plans for Friday, changed", seeded: 1 });
  }, 60_000);

  it("a link over words typed after a send came back unverified keeps them on screen and says so", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter("d-a", "Plans for Friday", "Shall we meet at noon?")]);
    await composerOn(s, "d-a", "Plans for Friday");
    Object.assign(s.refuseSend, { on: true, unverified: true });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => composeLine(s.el).includes(en.compose.statusUnverified), "A unverified", 240);
    await setSubject(s, "Plans for Friday, at one");
    await rounds(100);
    await s.mailto.open(LINK);
    await waitFor(() => toasts().includes(en.drafts.reopenBlockedUnsaved), "the refusal said", 240);
    await rounds(10);
    expect({ shown: subject(s)?.value, seeded: s.mailto.seeded }).toEqual({ shown: "Plans for Friday, at one", seeded: 1 });
  }, 60_000);

  /* THE DESKTOP'S LAUNCH: its mirror is rebuilt at each start, so the drafts arrive with the first sync. */
  const atLaunch = async (): Promise<{ store: MirrorStore; remoteAtStart: SyncChange[] }> => {
    const store = new MemoryMirrorStore();
    await store.load();
    const m = message("m1");
    const at = "2026-09-27T09:00:00.000Z";
    return {
      store,
      remoteAtStart: [
        { type: "message", op: "create", id: m.id, seq: 0, updatedAt: m.updatedAt, entity: m } as SyncChange,
        {
          type: "rule", op: "create", id: "r-colleague", seq: 0, updatedAt: at,
          entity: { id: "r-colleague", kind: "sender", match: "colleague@example.invalid", destination: "INBOX", enabled: true, createdAt: at },
        } as SyncChange,
        { type: "draft", op: "create", id: "d-r", seq: 0, updatedAt: at, entity: letter("d-r", "Plans for Friday", "Shall we meet at noon?") } as unknown as SyncChange,
      ],
    };
  };

  it("a link that starts the app over a letter its row already holds opens, and the row stays", async () => {
    const left = { ...EMPTY_COMPOSE, to: "Mila <mila@example.invalid>", subject: "Plans for Friday", body: "Shall we meet at noon?" };
    writeComposeDraft(left, storageOwner());
    writeComposeRow("d-r", storageOwner());
    markComposeRowHolds({ row: "d-r", sig: holdsSig(left) }, storageOwner());
    const s = await mountShell("#/ohbox", [], [], { ...await atLaunch(), mailto: LINK });
    await rowsWhenLinkShows(s);
    await waitFor(() => rows(s).length > 0, "the first sync's drafts", 240);
    expect(said()).not.toContain(en.drafts.reopenBlockedUnsaved);
    expect(rows(s)).toContain("Plans for Friday|Shall we meet at noon?");
  }, 60_000);

  it("a link that starts the app over a letter no row holds saves it first, its drafts arriving with the first sync", async () => {
    writeComposeDraft({ ...EMPTY_COMPOSE, subject: "Left unsaved last time", body: "Words only this buffer holds." }, storageOwner());
    const s = await mountShell("#/ohbox", [], [], { ...await atLaunch(), mailto: LINK });
    expect(await rowsWhenLinkShows(s)).toContain("Left unsaved last time|Words only this buffer holds.");
  }, 60_000);

  it("a link while a letter's send waits leaves it standing when no row holds its words", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter("d-a", "Plans for Friday", "Shall we meet at noon?")], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    s.offline.on = true;
    await setSubject(s, "Plans for Friday, typed offline");
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => sendPendingInDurableOutbox(s.engine, "compose"), "A waits on the outbox");
    await s.mailto.open(LINK);
    await rounds(40);
    expect({ shown: subject(s)?.value, frozen: subject(s)?.readOnly, seeded: s.mailto.seeded, hash: window.location.hash })
      .toEqual({ shown: "Plans for Friday, typed offline", frozen: true, seeded: 1, hash: "#/compose" });
    expect(composeLine(s.el)).toContain(en.compose.waitingNotSaved);
  }, 60_000);

  it("a link while a letter's send waits over its saved row opens, and the send goes on", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter("d-a", "Plans for Friday", "Shall we meet at noon?")], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 500 });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.engine.waitingSends().length === 1, "A waits");
    await s.mailto.open(LINK);
    expect(await rowsWhenLinkShows(s)).toEqual(["Plans for Friday|Shall we meet at noon?"]);
    expect({ readOnly: subject(s)?.readOnly, waiting: s.engine.waitingSends().map((w) => w.draftId) })
      .toEqual({ readOnly: false, waiting: ["d-a"] });
  }, 60_000);
});

/* ── A MAIL LINK WITH NO MAILBOX CONNECTED ───────────────────────────────────────────────────
   Nothing to protect, it opens at once with its fields and the shell says what is missing; over
   words no row can hold it answers at once. It never waits for a mailbox to appear. */
describe("a mail link with no mailbox connected", () => {
  const LINK = { to: ["lena@example.invalid"], cc: [], bcc: [], subject: "Hello from a link", body: "A line from the page." };
  /** Rounds of 25 ms, well inside the bounded wait a launch may take for what a save needs. */
  const AT_ONCE = RESTART_FLUSH_MS / 25 / 4;
  beforeEach(() => {
    try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
    setStorageOwner(OWNER);
    stubDom();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  });
  afterEach(async () => { await unmountAll(); resetComposerForTest(); resetStorageOwnerForTest(); });

  it("over words no row can hold, says at once that they stay, and keeps them", async () => {
    const s = await mountShell("#/ohbox", [], [], { noMailbox: true });
    await navigate("#/compose");
    await waitFor(() => letterSubject(s.el) != null, "the composer");
    await settleEditor();
    await setLine(letterSubject(s.el)!, "Notes from the meeting");
    await s.mailto.open(LINK);
    await waitFor(() => said().includes(en.drafts.reopenBlockedUnsaved), "the refusal said", AT_ONCE);
    expect({ shown: letterSubject(s.el)?.value ?? null, seeded: s.mailto.seeded }).toEqual({ shown: "Notes from the meeting", seeded: 1 });
  }, 60_000);

  it("opens the composer at once with the link's fields; Send cannot go, and the shell says no mailbox is connected", async () => {
    const s = await mountShell("#/ohbox", [], [], { noMailbox: true });
    await s.mailto.open(LINK);
    await waitFor(() => window.location.hash === "#/compose" && s.mailto.seeded === 1, "the link opened", AT_ONCE);
    await waitFor(() => letterSubject(s.el)?.value === LINK.subject, "the link's letter", 240);
    expect({
      to: s.el.querySelector(LETTER)?.textContent?.includes("lena@example.invalid"),
      sendDisabled: letterSend(s.el)?.disabled,
      said: s.el.textContent?.includes(en.frame.connection.noMailbox.title /* the strip's sentence, as the notice says the state */),
    }).toEqual({ to: true, sendDisabled: true, said: true });
  }, 60_000);
});
