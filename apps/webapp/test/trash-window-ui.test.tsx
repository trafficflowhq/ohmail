/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { KeymapProvider as KeymapProviderRaw } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { TrashView } from "../app/views/TrashView";
import type { TrashPage } from "@ohmail/app-logic/lists/trash-page";
import type { TrashWindowControl, TrashLiveBodyPhase } from "../app/shell/trash-window";
import type { TrashWindowItemWire, TrashWindowMailboxWire } from "../app/api-client";
import en from "../messages/en.json";
import de from "../messages/de.json";

/** Every view mount here sits under the keymap; the list surface's shell half rides with it. */
const KeymapProvider = ({ children }: { children?: React.ReactNode }) =>
  React.createElement(KeymapProviderRaw, { children: React.createElement(WithListGone, { children }) });

/**
 * THE TRASH VIEW'S SECOND SECTION — what the live window looks like in each of its states, and
 * the two properties that make it read-only on screen.
 *
 * The rows are the mail server's own \Trash, read live and never mirrored. Four states get a
 * twin here — rows, no folder to read, a read the server did not finish, and an empty folder —
 * plus the one that matters most: a live read that FAILS says so in its own section and leaves
 * the mirrored list untouched, because the two populations come from two different places and a
 * dead dial is not news about what ohmail deleted.
 *
 * MUTATIONS WATCHED are recorded per case; they are listed in the lane's report.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

function page(over: Partial<TrashPage> = {}): TrashPage {
  return {
    available: true, items: [], loading: false, error: null, exhausted: true,
    loadMore: () => {}, ...over,
  } as TrashPage;
}

/** A mirrored row — the population `useTrashPage` reads, unchanged by this lane. */
function mirrored(id: string, over: Record<string, unknown> = {}) {
  return {
    id, accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null,
    subject: `Mirrored ${id}`, from: { address: "s@x.example", name: "Sender" }, to: [], cc: [],
    date: "2026-01-01T00:00:00.000Z", folder: "Trash", snippet: "snip", unread: false,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none",
    updatedAt: "2026-09-09T10:00:00.000Z",
    trashedAt: "2026-09-09T09:00:00.000Z", restoreTo: "ohmail/News",
    ...over,
  };
}

/** A live row — a header fact off the folder, with the epoch its UID belongs to. */
function liveRow(uid: number, over: Partial<TrashWindowItemWire> = {}): TrashWindowItemWire {
  return {
    mailboxId: "mb1", uid, uidValidity: "77",
    subject: `Live ${uid}`, from: { name: `Name ${uid}`, address: `s${uid}@example.invalid` },
    date: `2026-09-0${uid}${"T"}10:00:00.000Z`, messageIdHeader: `<mid-${uid}@x>`,
    seen: false, origin: "provider", ...over,
  };
}

const okBox: TrashWindowMailboxWire = { id: "mb1", address: "a@example.invalid", window: "ok" };

/** The calls a press would make, recorded — the control is hand-built; the view is the subject. */
const pressed: string[] = [];

function control(over: Partial<TrashWindowControl> = {}): TrashWindowControl {
  return {
    supported: true,
    phase: "ready",
    items: [],
    mailboxes: [okBox],
    nextCursor: null,
    olderLoading: false,
    reload: () => pressed.push("reload"),
    loadOlder: () => pressed.push("loadOlder"),
    bodyFor: (): TrashLiveBodyPhase => ({ phase: "idle" }),
    openBody: () => pressed.push("openBody"),
    ...over,
  };
}

async function mount(
  p: TrashPage,
  live?: TrashWindowControl,
  catalogue: typeof en = en,
  locale = "en",
): Promise<HTMLElement> {
  pressed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() =>
    root!.render(
      h(NextIntlClientProvider, {
        locale,
        messages: catalogue as typeof en,
        timeZone: "UTC",
        children: h(KeymapProvider, {
          children: h(TrashView, {
            page: p, live, tags: [], now: new Date("2026-09-09T11:00:00.000Z"),
            onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
          } as never),
        }),
      }),
    ),
  );
  return host!;
}

/** `dataset`, not a `CSS.escape`d selector: jsdom here has no `CSS` object to escape with. */
const clickRow = async (el: HTMLElement, id: string): Promise<void> => {
  const node = [...el.querySelectorAll<HTMLButtonElement>(".row")]
    .find((n) => n.dataset.id === id);
  expect(node, `no row for ${id}`).not.toBeUndefined();
  await act(() => { node!.click(); });
};

const liveSection = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>(".trash-live");

// ── the four states, each with its own sentence ─────────────────────────────────────────────

describe("the live section's states", () => {
  it("ROWS: every live row is listed, with where it is named on it", async () => {
    const el = await mount(page(), control({ items: [liveRow(2), liveRow(1)] }));
    const sec = liveSection(el)!;
    expect(sec.textContent).toContain(en.trash.liveHead);
    expect([...sec.querySelectorAll(".row .subj")].map((n) => n.textContent))
      .toEqual(["Live 2", "Live 1"]);
    /* THE ORIGIN, ON EVERY ROW. The mirrored rows above gloss where a restore would put them;
       these name where they are instead, because there is nowhere to put them back to.
       Mutation watched: drop the `place` prop — this reads zero badges. */
    expect(
      [...sec.querySelectorAll(".badge")].filter((n) => n.textContent === en.trash.liveOrigin),
    ).toHaveLength(2);
    // Not a claim about emptiness anywhere near them.
    expect(sec.textContent).not.toContain(en.trash.liveEmpty);
  });

  it("ROWS: newest first by the message's own date, whatever order the page arrived in", async () => {
    /* The server merges each mailbox's page newest-first but under a per-mailbox sequence rule,
       so two mailboxes can interleave slightly out of date order. Mutation watched: return the
       rows unsorted from `byDateDesc` — this reads ["Live 1", "Live 3", "Live 2"]. */
    const el = await mount(page(), control({
      items: [liveRow(1), liveRow(3), liveRow(2)],
      mailboxes: [okBox],
    }));
    expect([...liveSection(el)!.querySelectorAll(".row .subj")].map((n) => n.textContent))
      .toEqual(["Live 3", "Live 2", "Live 1"]);
  });

  it("UNAVAILABLE: no Trash folder on the server is said, not shown as an empty folder", async () => {
    const el = await mount(page(), control({
      mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "no_trash_folder" }],
    }));
    const sec = liveSection(el)!;
    expect(sec.textContent).toContain(en.trash.liveUnavailable);
    expect(sec.textContent).not.toContain(en.trash.liveEmpty);
    expect(sec.querySelectorAll(".row")).toHaveLength(0);
  });

  it("READ-LIMITED: a read the server did not finish says so, and never says empty", async () => {
    /* Zero rows beside a mailbox that ran past the server's read budget is a read limit. The
       per-mailbox line names WHICH mailbox. Mutation watched: render `liveEmpty` for this
       verdict — the negative assertion below reddens. */
    const el = await mount(page(), control({
      mailboxes: [{ id: "mb1", address: "a@example.invalid", window: "unreachable" }],
    }));
    const sec = liveSection(el)!;
    expect(sec.textContent).toContain(en.trash.liveReadLimited);
    expect(sec.textContent).not.toContain(en.trash.liveEmpty);
    expect(sec.textContent).not.toContain(en.trash.liveUnavailable);
  });

  it("EMPTY: a folder that WAS read and holds nothing says exactly that", async () => {
    const el = await mount(page(), control({ mailboxes: [okBox], nextCursor: null }));
    const sec = liveSection(el)!;
    expect(sec.textContent).toContain(en.trash.liveEmpty);
    expect(sec.textContent).not.toContain(en.trash.liveReadLimited);
  });

  it("a per-mailbox degrade is named under whatever DID load", async () => {
    const el = await mount(page(), control({
      items: [liveRow(1)],
      mailboxes: [okBox, { id: "mb2", address: "b@example.invalid", window: "unreachable" }],
    }));
    const sec = liveSection(el)!;
    expect(sec.querySelectorAll(".row")).toHaveLength(1);
    expect(sec.textContent).toContain("b@example.invalid");
  });

  it("SHOW OLDER is a press, and it is the only way the section pages", async () => {
    const el = await mount(page(), control({ items: [liveRow(1)], nextCursor: "c1" }));
    const older = liveSection(el)!.querySelector<HTMLButtonElement>(".trash-live-older button");
    expect(older?.textContent).toBe(en.trash.liveOlder);
    await act(() => { older!.click(); });
    expect(pressed).toEqual(["loadOlder"]);
  });
});

// ── the failing live read, and the mirrored section beside it ───────────────────────────────

describe("a failing live read", () => {
  it("says so in its own section and leaves the mirrored list exactly as it was", async () => {
    /* THE PROPERTY THE BRIEF NAMES. Two populations, two sources: the mirror answered and the
       folder did not, so the mirrored rows, their restore gloss and the scope sentence all
       stand. Mutation watched: render the live section INSTEAD of the list when its phase is
       `failed` — the three mirrored assertions redden at once. */
    const el = await mount(
      page({ items: [mirrored("m1"), mirrored("m2")] as never }),
      control({ phase: "failed" }),
    );
    // Rows OUTSIDE the live section — the mirrored list, which the failed read must not touch.
    const mirroredSubjects = [...el.querySelectorAll<HTMLElement>(".row")]
      .filter((n) => n.closest(".trash-live") === null)
      .map((n) => n.querySelector(".subj")?.textContent);
    expect(mirroredSubjects).toContain("Mirrored m1");
    expect(mirroredSubjects).toContain("Mirrored m2");
    expect(el.querySelectorAll(".trash-to")).toHaveLength(2);
    expect(el.textContent).toContain(en.trash.footLive);
    const sec = liveSection(el)!;
    expect(sec.textContent).toContain(en.trash.liveFailed);
    // FAILED, never empty — and the retry is a press, not a loop.
    expect(sec.textContent).not.toContain(en.trash.liveEmpty);
    const retry = sec.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent).toBe(en.trash.liveRetry);
    await act(() => { retry!.click(); });
    expect(pressed).toEqual(["reload"]);
  });

  it("and the mirrored section's own unavailable state does not hide the live one", async () => {
    /* The other direction of the same independence: a client that cannot list ohmail's own
       deletes can still read the folder. */
    const el = await mount(page({ available: false }), control({ items: [liveRow(1)] }));
    expect(el.textContent).toContain(en.trash.unavailable);
    expect(liveSection(el)!.querySelectorAll(".row")).toHaveLength(1);
  });
});

// ── the reading column: one verb set, or none ───────────────────────────────────────────────

describe("opening a row", () => {
  it("a LIVE row shows its body and has ZERO actions", async () => {
    const el = await mount(
      page({ items: [mirrored("m1")] as never }),
      control({
        items: [liveRow(1)],
        bodyFor: () => ({ phase: "ready", text: "the live body text" }),
      }),
    );
    // The resting state is the mirrored pick, whose bar carries restore.
    expect(el.querySelector(".abar-trash")).not.toBeNull();
    await clickRow(el, "mb1:77:1");
    const reading = el.querySelector<HTMLElement>(".trash-live-read");
    expect(reading, "the live reading half is on screen").not.toBeNull();
    expect(reading!.textContent).toContain("the live body text");
    expect(reading!.textContent).toContain("Live 1");
    /* ZERO ACTIONS, and the emptiness is decided by `trashReadVerbs` rather than by an omitted
       prop. Mutation watched: return `restore_and_read` for a live row in `trashReadVerbs` —
       the reading half disappears and the first assertion above reddens. Mutation watched:
       pass `trash`-less `MessagePane` here instead — `.abar` reappears with eleven groups. */
    expect(el.querySelector(".abar")).toBeNull();
    expect(reading!.querySelectorAll("button")).toHaveLength(0);
    expect(el.textContent).not.toContain(en.trash.restore);
    // And the read-only fact is stated where a verb strip would have been.
    expect(reading!.textContent).toContain(en.trash.liveReadOnly);
  });

  it("a live body that could not be read says so, with a retry and nothing else", async () => {
    const el = await mount(page(), control({
      items: [liveRow(1)],
      bodyFor: () => ({ phase: "failed" }),
    }));
    await clickRow(el, "mb1:77:1");
    const reading = el.querySelector<HTMLElement>(".trash-live-read")!;
    expect(reading.textContent).toContain(en.trash.liveBodyFailed);
    const buttons = [...reading.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe(en.body.retry);
  });

  it("a MIRRORED row keeps restore — the positive control on the same switch", async () => {
    const el = await mount(
      page({ items: [mirrored("m1"), mirrored("m2")] as never }),
      control({ items: [liveRow(1)] }),
    );
    await clickRow(el, "mb1:77:1");
    expect(el.querySelector(".abar-trash")).toBeNull();
    // Back to the mirror: the restore bar returns and the live reading half goes.
    await clickRow(el, "m2");
    expect(el.querySelector(".abar-trash")).not.toBeNull();
    expect(el.textContent).toContain(en.trash.restore);
    expect(el.querySelector(".trash-live-read")).toBeNull();
  });

  it("selecting a live row asks for its body once, through the window", async () => {
    const el = await mount(page(), control({ items: [liveRow(1)] }));
    await clickRow(el, "mb1:77:1");
    expect(pressed).toEqual(["openBody"]);
  });

  it("RE-RENDERING does not re-ask, even for a body that FAILED", async () => {
    /* THE RETRY-LOOP CONTROL, and it needs a control object whose identity MOVES — the hook
       returns a fresh one every render, and the session door re-admits a `failed` key, so an
       effect keyed on the control would dial the provider once per render with nobody behind
       it. The probe below builds a new control per render for exactly that reason.
       Mutation watched: add the control to the effect's dependency list in `TrashView` — the
       recorded presses read three instead of one. */
    let bump: (() => void) | null = null;
    function Probe(): React.ReactElement {
      const [, setTick] = React.useState(0);
      bump = () => setTick((n) => n + 1);
      return h(TrashView, {
        page: page(), tags: [], now: new Date("2026-09-09T11:00:00.000Z"),
        live: control({ items: [liveRow(1)], bodyFor: () => ({ phase: "failed" }) }),
        onOpen: () => {}, hydrateBody: () => {}, onAction: () => {}, onAddTag: () => {},
      } as never);
    }
    pressed.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages: en, timeZone: "UTC",
          children: h(KeymapProvider, { children: h(Probe) }),
        }),
      ),
    );
    await clickRow(host!, "mb1:77:1");
    expect(pressed).toEqual(["openBody"]);
    await act(() => { bump!(); });
    await act(() => { bump!(); });
    expect(pressed).toEqual(["openBody"]);
  });
});

// ── the section's presence, and the sentence that describes the view ────────────────────────

describe("without a live window", () => {
  it("the view is what it was, and the foot names the mirror alone", async () => {
    const el = await mount(page({ items: [mirrored("m1")] as never }));
    expect(liveSection(el)).toBeNull();
    /* TWO FOOT KEYS, one per configuration: a single sentence naming a second section would
       claim a section that is not on screen. Mutation watched: render `footLive` here — the
       negative assertion reddens. */
    expect(el.textContent).toContain(en.trash.foot);
    expect(el.textContent).not.toContain(en.trash.footLive);
  });

  it("and with one, the foot says both populations and that the second is read-only", async () => {
    const el = await mount(page({ items: [mirrored("m1")] as never }), control());
    expect(el.textContent).toContain(en.trash.footLive);
  });
});

describe("in German", () => {
  it("renders the section, its heading and its states from the same keys", async () => {
    const el = await mount(
      page({ items: [mirrored("m1")] as never }),
      control({ items: [liveRow(1)] }),
      de as unknown as typeof en,
      "de",
    );
    const sec = liveSection(el)!;
    expect(sec.textContent).toContain(de.trash.liveHead);
    expect(sec.textContent).toContain(de.trash.liveOrigin);
    expect(el.textContent).toContain(de.trash.footLive);
  });
});

describe("a live row at phone width opens in Trash's own sheet", () => {
  /* Under the breakpoint the reading column is hidden (one rule for every split view), and a live
     row has no mirror id for the shell's reader — so the view raises its own. */
  const narrow = (on: boolean) => Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: on && /max-width/.test(query), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  const sheet = () => document.querySelector<HTMLElement>(".reader[role=dialog]");

  it("the press opens the sheet with the live read, and Escape closes it", async () => {
    narrow(true);
    const el = await mount(page(), control({ items: [liveRow(1)], bodyFor: () => ({ phase: "ready", text: "the live body text" }) }));
    expect(sheet()).toBeNull();
    await clickRow(el, "mb1:77:1");
    expect(sheet(), "no sheet over a hidden column").not.toBeNull();
    expect(sheet()!.textContent).toContain("the live body text");
    await act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(sheet()).toBeNull();
  });

  it("control: at a desktop width the column reads it and no sheet opens", async () => {
    narrow(false);
    const el = await mount(page(), control({ items: [liveRow(1)], bodyFor: () => ({ phase: "ready", text: "the live body text" }) }));
    await clickRow(el, "mb1:77:1");
    expect(sheet()).toBeNull();
    expect(el.querySelector(".trash-live-read")!.textContent).toContain("the live body text");
  });
});
