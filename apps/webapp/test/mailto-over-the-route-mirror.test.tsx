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
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { MemoryMirrorStore, type EngineDraft, type MirrorStore, type SyncChange } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { go, parseHash, reflectMessage } from "../app/shell/routing";
import { EMPTY_COMPOSE, markComposeRowHolds, resetComposerForTest, writeComposeDraft, writeComposeRow } from "../app/shell/compose";
import { holdsSig } from "../app/shell/compose-autosave";
import { sendPendingInDurableOutbox } from "../app/shell/mail-send";
import { RESTART_FLUSH_MS } from "../app/shell/app-update";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "./_draft-shell.js";
import { composeLine, composeSend, composeSubject, composerOn, letter, navigate, rounds, toasts } from "./_handoff-steps.js";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shellDir = resolve(process.cwd(), "apps/webapp/app/shell");
const read = (name: string): string => readFileSync(resolve(shellDir, name), "utf8");

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
  it("calls useShellCompose below useShellOpenState", () => {
    const shell = read("AppShell.tsx");
    const open = shell.indexOf("} = useShellOpenState({");
    const compose = shell.indexOf("} = useShellCompose({");
    expect(open, "useShellOpenState is not called in AppShell.tsx").toBeGreaterThan(0);
    expect(compose, "useShellCompose is not called in AppShell.tsx").toBeGreaterThan(0);
    expect(compose).toBeGreaterThan(open);
  });

  /* The same claim over a swapped copy of the source: the comparison above is what decides, not
     the two names being present. */
  it("refuses the swapped source", () => {
    const shell = read("AppShell.tsx");
    const swapped = shell
      .replace("} = useShellOpenState({", "} = useShellZZZState({")
      .replace("} = useShellCompose({", "} = useShellOpenState({")
      .replace("} = useShellZZZState({", "} = useShellCompose({");
    expect(swapped.indexOf("} = useShellCompose({"))
      .toBeLessThan(swapped.indexOf("} = useShellOpenState({"));
  });

  /* And the two effects are in the two frames the order is about — a mailto effect left behind
     in `AppShell.tsx` would be registered above the open state, whatever the call order says. */
  /* MAILTO-PARSER-HAS-THREE-HOMES: the one parser's draft reaches the composer whole — every
     surface carries to, cc, bcc, subject and body (the desktop's and the phone's halves are theirs). */
  it("seeds all five fields of the parsed draft", () => {
    const src = read("shell-compose.ts");
    for (const f of ["to: chips(mailtoDraft.to)", "cc: chips(mailtoDraft.cc)", "bcc: chips(mailtoDraft.bcc)", "subject: mailtoDraft.subject", "body: mailtoDraft.body"]) {
      expect(src, `the seeder drops ${f}`).toContain(f);
    }
  });

  it("holds the mailto effect in shell-compose.ts and the mirror write in shell-open-state.ts", () => {
    /* The effect's own BODY, not the file: `writeTo` navigates to the composer too, so a file-wide
       `toContain` would read its copy and pass over a mailto effect that had stopped navigating. */
    const compose = read("shell-compose.ts");
    const deps = "[mailtoDraft, autosave, go, onMailtoDraftSeeded]";
    const end = compose.indexOf(deps);
    expect(end, "the mailto effect's dependency array is not in shell-compose.ts").toBeGreaterThan(0);
    const start = compose.lastIndexOf("useEffect(() => {", end);
    expect(compose.slice(start, end), "the mailto effect no longer navigates to the composer")
      .toContain('go("compose");');
    expect(read("shell-open-state.ts")).toContain("reflectMessage(route, openOnScreen);");
    expect(read("AppShell.tsx")).not.toContain(deps);
  });
});

/* ── A MAIL LINK OVER WORDS THE COMPOSER HOLDS ───────────────────────────────────────────────
   The link's letter replaces what is on screen only once those words are on the account: saved
   first, never asked, and a link whose save was refused leaves them where they are. */
describe("a mail link over a letter being written", () => {
  const LINK = { to: ["lena@example.invalid"], cc: [], bcc: [], subject: "Hello from a link", body: "" };
  const subject = (s: DraftShell): HTMLInputElement | null => s.el.querySelector<HTMLInputElement>("#compose-subject");
  const rows = (s: DraftShell): string[] => s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft")
    .map((d) => `${d.subject}|${(d.body ?? "").trim()}`);
  async function setSubject(s: DraftShell, value: string): Promise<void> {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(subject(s)!, value);
      subject(s)!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  /** Rows on the account at the moment the composer first shows the link's letter. */
  async function rowsWhenLinkShows(s: DraftShell): Promise<string[]> {
    await waitFor(() => subject(s)?.value === LINK.subject, "the link's letter", 240);
    return rows(s);
  }
  beforeEach(() => {
    try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
    stubDom();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  });
  afterEach(async () => { await unmountAll(); resetComposerForTest(); });

  it("words typed inside the pause are saved as a draft before the link's letter opens", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], []);
    await navigate("#/compose");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await settleEditor();
    await setSubject(s, "Notes from the meeting");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!, "We agreed on three things."); });
    await s.mailto.open(LINK);
    expect(await rowsWhenLinkShows(s)).toEqual(["Notes from the meeting|We agreed on three things."]);
    expect(s.mailto.seeded).toBe(1);
  }, 60_000);

  it("a link that starts the app saves the letter the last session left before it opens", async () => {
    writeComposeDraft({ ...EMPTY_COMPOSE, subject: "Left unsaved last time", body: "Words only this buffer holds." });
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
    writeComposeDraft(left);
    writeComposeRow("d-r");
    markComposeRowHolds({ row: "d-r", sig: holdsSig(left) });
    const s = await mountShell("#/ohbox", [], [], { ...await atLaunch(), mailto: LINK });
    await rowsWhenLinkShows(s);
    await waitFor(() => rows(s).length > 0, "the first sync's drafts", 240);
    expect(toasts()).not.toContain(en.drafts.reopenBlockedUnsaved);
    expect(rows(s)).toContain("Plans for Friday|Shall we meet at noon?");
  }, 60_000);

  it("a link that starts the app over a letter no row holds saves it first, its drafts arriving with the first sync", async () => {
    writeComposeDraft({ ...EMPTY_COMPOSE, subject: "Left unsaved last time", body: "Words only this buffer holds." });
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
    expect(s.el.querySelector(".view-compose .send-row")?.textContent ?? "").toContain(en.compose.waitingNotSaved);
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
    stubDom();
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  });
  afterEach(async () => { await unmountAll(); resetComposerForTest(); });

  it("opens the composer at once with the link's fields; Send cannot go, and the shell says no mailbox is connected", async () => {
    const s = await mountShell("#/ohbox", [], [], { noMailbox: true });
    await s.mailto.open(LINK);
    await waitFor(() => window.location.hash === "#/compose" && s.mailto.seeded === 1, "the link opened", AT_ONCE);
    await waitFor(() => composeSubject(s.el) === LINK.subject, "the link's letter", 240);
    expect({
      to: s.el.querySelector(".view-compose")?.textContent?.includes("lena@example.invalid"),
      sendDisabled: composeSend(s.el)?.disabled,
      said: s.el.textContent?.includes(en.sync.noMailbox),
    }).toEqual({ to: true, sendDisabled: true, said: true });
  }, 60_000);

  it("over words no row can hold, says at once that they stay, and keeps them", async () => {
    const s = await mountShell("#/ohbox", [], [], { noMailbox: true });
    await navigate("#/compose");
    await waitFor(() => s.el.querySelector<HTMLInputElement>("#compose-subject") != null, "the composer");
    await settleEditor();
    await act(async () => {
      const input = s.el.querySelector<HTMLInputElement>("#compose-subject")!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "Notes from the meeting");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await s.mailto.open(LINK);
    await waitFor(() => toasts().includes(en.drafts.reopenBlockedUnsaved), "the refusal said", AT_ONCE);
    expect({ shown: composeSubject(s.el), seeded: s.mailto.seeded }).toEqual({ shown: "Notes from the meeting", seeded: 1 });
  }, 60_000);
});
