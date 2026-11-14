/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { UNDO_MS } from "@ohmail/app-logic/press/delete-undo";
import { storeMessage } from "./_store-fixture";
import {
  ISO, act as shellAct, answerStoreWith, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import {
  items,
  key,
  letter,
  menu,
  moreButton,
  mountPanel,
  openMore,
  panel,
  press,
  pressItem,
  pressVerb,
  shown,
  verb,
} from "./_reader-1-panel.js";

/**
 * THE OPEN LETTER's ACTION PANEL, over the new reader (`packages/app/src/reader/actions/ActionBar.tsx`).
 *
 * A report, from reading their own mail: *"it breaks a line and doesn't show shortcuts and my
 * feedback already given, allow mark read / unread in it intelligently"* — the SECOND time
 * this surface has been reported, which is the actual severity.
 *
 * These cases were written over today's `MessagePane` and its `onAction` seam; they now mount the
 * reader through its own test door (`_reader-1-panel.tsx`), where the list that opened the letter
 * hands its visit and every verb the panel runs reaches the list's own path (`visit.act`), the seam
 * `onAction` was. Their claims stand as they were written. Where today's markup was the claim (the
 * density ladder's classes, `action-bar.css`'s rules) the case left with today's view, its row
 * naming the case of the new panel or the kit that holds the behaviour behind it
 * (`tools/old-tests.tsv`).
 */

/** Tuesday 4 August 2026, noon UTC: the resurface horizons below are minted from it, in the reader's zone (UTC). */
const NOW = new Date("2026-08-04T12:00:00.000Z");

/** The keys today's bar showed caps for, in the row's order. */
const BAR_CHORDS = ["r", "a", "e", "b", "t", "s", "u", "shift+i"] as const;

/** A letter with an audience: two listed recipients beside the sender. */
const AUDIENCE = {
  to: [
    { name: null, address: "me@example.test" },
    { name: "Piet", address: "piet@atelier.example" },
  ],
};
/** One tag on the account, so the Tag verb stands. */
const TAGS = { "t-work": "Work" };

const realTz = process.env.TZ;
beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  /* The resurface presets mint 09:00 IN THE READER'S ZONE: pinned to UTC, so the instants asserted below are about
     the chooser rather than about the machine running the suite. */
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;
});

/** Open a message served only by the backend's History page. The sync fixture serves one different message. */
async function openStoreLetter(holdBody = false) {
  const message = storeMessage(0, "2024-03-20T10:00:00.000Z", {
    accountId: "acct_live_1", subject: "A letter from the archive",
  });
  answerStoreWith([message]);
  const sync = page(1);
  answerSyncWith(() => sync.clone());
  const endpoint = `/messages/${message.id}`;
  const calls: string[] = [];
  const body = Response.json({ text: "Archive body", html: null, loadedRemoteContent: false });
  let releaseBody = () => {};
  const bodyAnswer = holdBody
    ? new Promise<Response>((resolve) => { releaseBody = () => resolve(body); })
    : Promise.resolve(body);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input).split("?")[0]!;
    const method = init?.method ?? "GET";
    if (url.endsWith(`${endpoint}/body`)) {
      calls.push("body");
      return (await bodyAnswer).clone();
    }
    if (url.endsWith(endpoint)) {
      if (method === "DELETE") calls.push("delete");
      return Response.json(message);
    }
    return fetch(input, init);
  };
  const host = await mountShell([mailbox({
    id: "mb_1", lastSyncAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO,
  })]);
  await goTo("history");
  const row = within(host).getByRole("option", { name: /A letter from the archive/ });
  await shellAct(async () => { row.click(); });
  await tick(100);
  expect(within(host).getByRole("heading", { name: message.subject })).toBeTruthy();
  return { host, calls, releaseBody };
}

/** The keycaps the panel carries, on the verbs it shows, in its order. */
const caps = (): string[] =>
  [...panel().querySelectorAll<HTMLElement>("button:not([hidden]) kbd")].map((k) => k.textContent ?? "");

/* ══ THE KEYS ON THE PANEL ════════════════════════════════════════════════════════════════ */

describe("the bar shows the keys, and reads them from the keymap", () => {
  it("shows a cap for every bound verb — seven, where the bar used to show one", () => {
    mountPanel({}, { bound: BAR_CHORDS, tags: TAGS });
    expect(caps()).toEqual(["r", "a", "e", "b", "t", "s", "u"]);
  });

  it("shows NO cap for a verb whose key is not bound here", () => {
    mountPanel({}, { bound: ["r", "a", "e", "u"], tags: TAGS });
    expect(caps()).toEqual(["r", "a", "e", "u"]);
  });

  it("shows no caps at all with no registry behind it, rather than guessing", () => {
    mountPanel({}, { bound: [], tags: TAGS });
    expect(caps()).toEqual([]);
  });
});

/* ══ THE READ CONTROL ═════════════════════════════════════════════════════════════════════ */

describe("the read control says what pressing it will DO", () => {
  it("a READ message offers Mark unread", () => {
    mountPanel({ unread: false }, { visit: false });
    expect(verb("Mark unread")).not.toBeNull();
    expect(verb("Mark read")).toBeNull();
  });

  it("an UNREAD message offers Mark as read, in the SAME slot", () => {
    mountPanel({ unread: true }, { visit: false });
    const slots = shown().filter((n) => /^Mark (read|unread)$/.test(n));
    expect(slots).toEqual(["Mark read"]);
  });

  it("never both directions at once — the slot is a slot, not a pair", async () => {
    const { openOther } = mountPanel({ unread: false }, { visit: false, others: [letter("m2", { unread: true })] });
    expect(shown().filter((n) => /^Mark (read|unread)$/.test(n))).toEqual(["Mark unread"]);
    await openOther("m2");
    expect(shown().filter((n) => /^Mark (read|unread)$/.test(n))).toEqual(["Mark read"]);
  });

  it("is not a switch, and states its verb in the label rather than a title", () => {
    mountPanel({ unread: false }, { visit: false });
    const slot = verb("Mark unread")!;
    expect(slot.getAttribute("role")).toBeNull();
    expect(slot.getAttribute("aria-checked")).toBeNull();
  });

  it("shows the `u` keycap on the read control, from the registry", () => {
    mountPanel({ unread: false }, { bound: BAR_CHORDS });
    expect(verb("Mark unread")!.querySelector("kbd")?.textContent).toBe("u");
  });

  it("shows the `⇧I` keycap on the Mark-as-read arm, from the same registry", () => {
    mountPanel({ unread: true }, { bound: BAR_CHORDS, visit: false });
    expect(verb("Mark read")!.querySelector("kbd")?.textContent).toBe("⇧ i");
  });

  it("shows NO cap on the Mark-as-read arm where `⇧I` is not bound", () => {
    mountPanel({ unread: true }, { bound: ["r", "a", "e", "s", "u"], visit: false });
    const control = verb("Mark read")!;
    const visible = control.cloneNode(true) as HTMLElement;
    for (const hidden of visible.querySelectorAll("[aria-hidden=true]")) hidden.remove();
    expect(visible.textContent?.trim()).toBe("Mark read");
    expect(control.querySelector("kbd")).toBeNull();
  });
});

/* The control's press takes the list's own path, so the list's dwell pin and Undo apply: it never writes a
   mark_seen of its own beside the list. Where no list's visit stands, the reader's own runner writes it. */
describe("the read control presses the KEY — it does not dispatch its own mark_seen", () => {
  it("runs the registry's `u` binding, so OhboxView's dwell pin still applies", async () => {
    const { actions, mail } = mountPanel({ unread: false });
    await pressVerb("Mark unread");
    expect(actions).toEqual(["unread"]);
    expect(mail.mutations).toEqual([]);
  });

  it("presses the CURRENT handler each time, not the one the registry last memoised", async () => {
    const { actions, mail } = mountPanel({ unread: false });
    await pressVerb("Mark unread");
    await act(() => mail.patch("m1", { snippet: "a later render" }));
    await pressVerb("Mark unread");
    expect(actions).toEqual(["unread", "unread"]);
    expect(mail.mutations).toEqual([]);
  });

  it("falls back to the shell only where the key is not bound at all", async () => {
    const { mail } = mountPanel({ unread: false }, { visit: false });
    await pressVerb("Mark unread");
    expect(mail.mutations).toEqual([expect.objectContaining({ kind: "mark_seen", unread: true })]);
  });

  it("does not press a DISABLED binding, it uses the fallback", async () => {
    const { actions, ran } = mountPanel({ unread: false }, { bound: BAR_CHORDS, disabled: ["u"] });
    await pressVerb("Mark unread");
    expect(ran).toEqual([]);
    expect(actions).toEqual(["unread"]);
  });

  it("Mark as read runs the registry's `⇧I` binding — the READ direction, never `u`", async () => {
    const { mail, ran } = mountPanel({ unread: true }, { bound: BAR_CHORDS, visit: false });
    await pressVerb("Mark read");
    expect(ran).toEqual([]);
    expect(mail.mutations).toEqual([expect.objectContaining({ kind: "mark_seen", unread: false })]);
  });

  it("Mark as read falls back to the shell where `⇧I` is not bound", async () => {
    const { mail, ran } = mountPanel({ unread: true }, { bound: [], visit: false });
    await pressVerb("Mark read");
    expect(ran).toEqual([]);
    expect(mail.mutations).toEqual([expect.objectContaining({ kind: "mark_seen", unread: false })]);
  });

  it("Mark as read does not press a DISABLED `⇧I` either", async () => {
    const { mail, ran } = mountPanel({ unread: true }, { bound: BAR_CHORDS, disabled: ["shift+i"], visit: false });
    await pressVerb("Mark read");
    expect(ran).toEqual([]);
    expect(mail.mutations).toEqual([expect.objectContaining({ kind: "mark_seen", unread: false })]);
  });
});

/* ══ EVERY VERB STILL REACHABLE ═══════════════════════════════════════════════════════════ */

describe("every verb the flat row had is still reachable", () => {
  it("dispatches reply, two horizons and screening from the row; resurface via its chooser", async () => {
    const { actions } = mountPanel();
    await pressVerb("Reply");
    await pressVerb("Later");
    await pressVerb("Park");
    await pressVerb("Resurface");
    await pressItem("Resurface", /^Tomorrow/);
    expect(actions).toEqual(["reply", "later", "aside", "resurface:2026-08-05T09:00:00.000Z"]);
  });

  // The sender's screening action belongs to the Screener. Keep its behavior separate from the open letter's action bar.
  it("the sender's screening stands in the row beside the letter's verbs", async () => {
    const { actions } = mountPanel();
    await pressVerb("Screening");
    expect(actions).toEqual(["screen"]);
  });

  it("keeps Draft reply — in More, where the AI verb belongs while no model is connected", async () => {
    const draft = vi.fn();
    mountPanel({}, { draft });
    await openMore();
    expect(items("More")).toContain("Draft reply");
    await pressItem("More", "Draft reply");
    expect(draft).toHaveBeenCalledWith("m1");
  });

  it("a pane whose host names no drafter offers no Draft reply", async () => {
    mountPanel();
    await openMore();
    expect(items("More"), "More opened no menu of verbs").toContain("Move");
    expect(items("More"), "a host with no drafter was offered a draft").not.toContain("Draft reply");
    expect(shown()).not.toContain("Draft reply");
  });

  it("offers a way back out of both panels", async () => {
    const { actions } = mountPanel();
    await openMore();
    await pressItem("More", "Move");
    expect(menu("Move")).not.toBeNull();
    await key(menu("Move")!, "Escape");
    expect(menu("Move")).toBeNull();
    await pressVerb("Resurface");
    await pressItem("Resurface", "Cancel");
    expect(menu("Resurface")).toBeNull();
    expect(shown()).toContain("Reply");
    expect(actions).toEqual([]);
  });
});

/* ══ THE RESURFACE CHOOSER ════════════════════════════════════════════════════════════════ */

describe("the resurface horizon chooser", () => {
  it("a preset dispatches a CONCRETE instant and closes the panel", async () => {
    const { actions } = mountPanel();
    await pressVerb("Resurface");
    await pressItem("Resurface", /^Next week/);
    expect(actions).toEqual(["resurface:2026-08-10T09:00:00.000Z"]);
    expect(menu("Resurface")).toBeNull();
  });

  it("Now dispatches the direct transition — never a `resurface:` date", async () => {
    const { actions } = mountPanel();
    await pressVerb("Resurface");
    await pressItem("Resurface", /^Now$/);
    expect(actions).toEqual(["resurface_now"]);
    expect(actions.every((a) => !a.startsWith("resurface:")), "Now was spelled as a date").toBe(true);
    expect(menu("Resurface")).toBeNull();
  });

  const picker = (): HTMLElement | null => screen.queryByRole("menu", { name: "Pick a date" });
  const dayCell = (label: RegExp): HTMLButtonElement =>
    within(picker()!).getByRole("button", { name: label }) as HTMLButtonElement;
  async function openPicker(): Promise<void> {
    await pressVerb("Resurface");
    await pressItem("Resurface", "Pick a date");
  }

  it("picking a calendar day dispatches that day at 09:00 in the reader's zone", async () => {
    const { actions } = mountPanel();
    await openPicker();
    await press(dayCell(/^Thu 20 Aug 2026/));
    expect(actions).toEqual(["resurface:2026-08-20T09:00:00.000Z"]);
    expect(picker(), "the picker outlived its answer").toBeNull();
  });

  it("a day before the floor dispatches NOTHING, and the picker stays open", async () => {
    const { actions } = mountPanel();
    await openPicker();
    await press(dayCell(/^Tue 4 Aug 2026/));
    expect(actions, "a past day was accepted").toEqual([]);
    expect(picker(), "the picker closed on a day it refused — the press looked like it worked").not.toBeNull();
  });

  it("the grid roves with the arrows, and Enter picks the day the cursor is on", async () => {
    const { actions } = mountPanel();
    await openPicker();
    expect((document.activeElement?.getAttribute("aria-label") ?? "").startsWith("Wed 5 Aug 2026")).toBe(true);
    await key(document.activeElement!, "ArrowRight");
    await key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/^Thu 13 Aug 2026/);
    await key(document.activeElement!, "Enter");
    expect(actions).toEqual(["resurface:2026-08-13T09:00:00.000Z"]);
  });

  it("Escape closes the PICKER and returns focus to the capsule — the panel stays", async () => {
    const { actions } = mountPanel();
    await openPicker();
    expect(picker()).not.toBeNull();
    await key(picker()!, "Escape");
    expect(picker(), "Escape left the picker open").toBeNull();
    expect(document.activeElement, "focus was dropped on the floor").toBe(verb("Resurface"));
    expect(shown(), "Escape took the panel with it").toContain("Resurface");
    expect(actions).toEqual([]);
  });

  it("an outside press dismisses the picker, and a message swap closes it", async () => {
    const { openOther } = mountPanel({}, { others: [letter("m2", { unread: false })] });
    await openPicker();
    await act(() => {
      fireEvent.pointerDown(document.querySelector("[data-veil]")!);
    });
    expect(picker(), "an outside press left the picker standing").toBeNull();
    expect(shown(), "the outside press took the panel too").toContain("Resurface");
    await openPicker();
    expect(picker()).not.toBeNull();
    await openOther("m2");
    expect(picker(), "the picker survived a message swap").toBeNull();
  });

  it("Cancel dispatches nothing and restores the row", async () => {
    const { actions } = mountPanel();
    await pressVerb("Resurface");
    await pressItem("Resurface", "Cancel");
    expect(actions).toEqual([]);
    expect(menu("Resurface")).toBeNull();
    expect(shown()).toContain("Resurface");
  });
});

/* ══ MORE ═════════════════════════════════════════════════════════════════════════════════ */

describe("More holds the verbs the row dropped", () => {
  it("aria-expanded REPORTS THE MENU — it was the literal `false` and it lied both ways", async () => {
    mountPanel();
    expect(moreButton().getAttribute("aria-haspopup")).toBe("menu");
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
    await openMore();
    expect(moreButton().getAttribute("aria-expanded")).toBe("true");
    await key(menu("More")!, "Escape");
    expect(moreButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes it and RETURNS FOCUS to the button that opened it", async () => {
    mountPanel();
    await openMore();
    await key(menu("More")!, "Escape");
    expect(menu("More")).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it("a verb closes the menu and dispatches", async () => {
    const { actions } = mountPanel({}, { fold: true });
    await openMore();
    await pressItem("More", "Later");
    expect(menu("More")).toBeNull();
    expect(actions).toEqual(["later"]);
  });

  it("the two verbs that ask a QUESTION close the menu and open their panel", async () => {
    const { actions } = mountPanel({}, { fold: true });
    await openMore();
    await pressItem("More", "Resurface");
    expect(menu("More")).toBeNull();
    expect(actions, "opening the chooser is not itself an action").toEqual([]);
    expect(menu("Resurface")).not.toBeNull();
    await pressItem("Resurface", /^Tomorrow/);
    expect(actions).toEqual(["resurface:2026-08-05T09:00:00.000Z"]);
    await openMore();
    await pressItem("More", "Move");
    expect(menu("More")).toBeNull();
    expect(menu("Move")).not.toBeNull();
    await pressItem("Move", "News");
    expect(actions).toEqual(["resurface:2026-08-05T09:00:00.000Z", "move:reads"]);
  });

  it("closes when the CURSOR moves to another message", async () => {
    const { openOther } = mountPanel({}, { others: [letter("m2", { unread: false })] });
    await openMore();
    expect(menu("More")).not.toBeNull();
    await openOther("m2");
    expect(menu("More"), "a menu carried onto the next message").toBeNull();
  });

  it("A KEY THE MENU HANDLES REACHES NOTHING ELSE — and `stopPropagation` was not enough", async () => {
    const MENU_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "Escape"];
    const { ran } = mountPanel({}, { bound: MENU_KEYS });
    for (const k of MENU_KEYS) {
      if (menu("More") === null) await openMore();
      await key(within(menu("More")!).getAllByRole("menuitem")[0]!, k);
    }
    expect(ran, "a key the menu handled reached the page's own keys too").toEqual([]);
    expect(menu("More")).toBeNull();
  });

  it("does NOT hold a Cancel — a menu you can dismiss anywhere needs no exit button", async () => {
    mountPanel();
    await openMore();
    expect(items("More")).not.toContain("Cancel");
  });

  it("closes a half-open panel when the CURSOR moves to another message", async () => {
    const { openOther } = mountPanel({}, { others: [letter("m2", { unread: false })] });
    await openMore();
    await pressItem("More", "Move");
    expect(menu("Move")).not.toBeNull();
    await openOther("m2");
    expect(menu("Move"), "a half-open Move carried onto the next message").toBeNull();
    expect(shown()).toContain("Reply");
  });
});

/* ══ REPLY ALL ════════════════════════════════════════════════════════════════════════════ */

describe("Reply all appears only on a message with an audience", () => {
  it("a multi-recipient message stands Reply all in the row, and it dispatches reply_all", async () => {
    const { actions } = mountPanel(AUDIENCE);
    await pressVerb("Reply all");
    expect(actions, "the verb must widen the audience, not repeat Reply").toEqual(["reply_all"]);
  });

  it("a 1:1 message renders NO Reply all — not in the row, not in the menu", async () => {
    mountPanel({ to: [{ name: null, address: "me@example.test" }] });
    expect(verb("Reply all"), "a Reply all on a 1:1 message is noise").toBeNull();
    await openMore();
    expect(items("More")).not.toContain("Reply all");
  });

  it("shows its keycap FROM THE REGISTRY — ⇧ r when bound, nothing when not", () => {
    mountPanel(AUDIENCE, { bound: [...BAR_CHORDS, "shift+r"] });
    expect(verb("Reply all")!.querySelector("kbd")?.textContent).toBe("⇧ r");
    cleanup();
    mountPanel(AUDIENCE, { bound: BAR_CHORDS });
    expect(verb("Reply all")!.querySelector("kbd")).toBeNull();
  });
});

/* ══ FORWARD ══════════════════════════════════════════════════════════════════════════════ */

describe("Forward stands in the pill", () => {
  it("stands in the row and dispatches `forward` — not `reply`, not a navigation", async () => {
    const { actions } = mountPanel();
    expect(verb("Forward"), "Forward has no row position — the ⋯ menu is its only door again").not.toBeNull();
    await pressVerb("Forward");
    expect(actions).toEqual(["forward"]);
  });

  it("stands SECOND, between the reply verbs and the horizons", () => {
    mountPanel(AUDIENCE);
    const labels = shown();
    const at = (p: string) => labels.indexOf(p);
    expect(at("Reply")).toBeGreaterThanOrEqual(0);
    expect(at("Forward")).toBeGreaterThan(at("Reply all"));
    expect(at("Later")).toBeGreaterThan(at("Forward"));
  });

  it("wears the keycap FROM THE REGISTRY — ⇧ f when bound, nothing when not", () => {
    mountPanel({}, { bound: [...BAR_CHORDS, "shift+f"] });
    expect(verb("Forward")!.querySelector("kbd")?.textContent).toBe("⇧ f");
    cleanup();
    mountPanel({}, { bound: BAR_CHORDS });
    expect(verb("Forward")!.querySelector("kbd")).toBeNull();
  });

  it("an OFF-MIRROR message still offers Forward — the press fetches its body first", async () => {
    vi.useRealTimers();
    installShellEnv();
    try {
      const { host, calls, releaseBody } = await openStoreLetter(true);
      const actions = within(host).getByRole("toolbar", { name: "Actions" });
      await shellAct(async () => { within(actions).getByRole("button", { name: "Forward" }).click(); });
      await tick(50);
      expect.soft(calls).toContain("body");
      expect.soft(within(host).queryByRole("region", { name: "Forward" })).toBeNull();
      await shellAct(async () => { releaseBody(); });
      await tick(100);
      expect(within(host).getByRole("region", { name: "Forward" })).toBeTruthy();
    } finally {
      await teardownShellEnv();
    }
  });

  it("a `no_forward` message still offers Forward — in the row; the press asks", async () => {
    const { actions } = mountPanel({
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: false },
    } as never);
    expect(verb("Forward"), "a no_forward message lost its Forward").not.toBeNull();
    await pressVerb("Forward");
    expect(actions).toEqual(["forward"]);
    await openMore();
    expect(items("More"), "Forward is in the row AND the menu").not.toContain("Forward");
  });
});

/* ══ TAG ══════════════════════════════════════════════════════════════════════════════════ */

describe("the Tag verb stands in the pill", () => {
  it("renders in the ROW, inside its own density group — not only behind More", () => {
    mountPanel({}, { tags: TAGS });
    const button = verb("Tag");
    expect(button, "the pill carries no Tag verb — that is the reported defect, verbatim").not.toBeNull();
    expect(panel().contains(button)).toBe(true);
  });

  it("shows the `t` cap FROM THE REGISTRY — and none where `t` is not bound", async () => {
    mountPanel({}, { tags: TAGS, bound: BAR_CHORDS });
    expect(verb("Tag")!.querySelector("kbd")?.textContent).toBe("t");
    cleanup();
    mountPanel({}, { tags: TAGS, bound: ["r", "a", "e", "b", "s", "u"] });
    expect(verb("Tag")!.querySelector("kbd"), "the bar invented a keycap for an unbound chord").toBeNull();
    cleanup();

    for (const fold of [false, true]) {
      const { mail, openOther } = mountPanel({}, { tags: TAGS, fold, others: [letter("m2")] });
      await openOther("m2");
      await key(fold ? moreButton() : verb("Tag")!, "t");
      const picker = screen.getByRole("menu", { name: "Tag" });
      await press(within(picker).getByRole("menuitemradio", { name: "Work" }));
      expect(mail.mutations).toContainEqual({ kind: "tag_assign", messageId: "m2", tagId: "t-work", assigned: true });
      cleanup();
    }
  });

  it("is ABSENT on a surface that cannot tag, rather than a verb that opens nothing", async () => {
    mountPanel({}, { tags: {} });
    expect(verb("Tag"), "a bar offered a tag verb it cannot run").toBeNull();
    await openMore();
    expect(items("More")).not.toContain("Tag");
  });
});

/* ══ WHAT IS NOT MARKUP OF TODAY's SHEETS ═════════════════════════════════════════════════ */

describe("the floating bar and the shared measure, as declared", () => {
  const css = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("THE LOCALE LANDS ON THE SAME COMMIT AS THE LABELS THE ROW MEASURES", async () => {
    /**
     * `:root[lang]` is a LAYOUT INPUT, not just an accessibility one: what the panel measures is the RENDERED
     * WIDTH of real labels, and `lang` is what selects the font and the shaping those labels are drawn with. So the
     * attribute has to be written during the render that also swaps the catalogue. In a passive effect it lands one
     * commit LATER, and the frame in between measures German words under the English `lang`. Asserted as the
     * absence of the deferral: move either write back into a `useEffect` and this goes red.
     */
    for (const rel of ["../app/(product)/LocaleShell.tsx", "../../desktop/src/DesktopLocale.tsx"]) {
      const src = css(rel);
      expect(src, `${rel} no longer stamps <html lang>`).toContain("documentElement.lang");
      const effects = [...src.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}/g)].map((m) => m[1]);
      for (const body of effects) {
        expect(
          body,
          `${rel} defers <html lang> to an effect — the rungs would read a stale locale for a frame`,
        ).not.toContain("documentElement.lang");
      }
      // …and it is guarded, so an unrelated re-render does not touch the DOM every pass.
      expect(src, `${rel} writes <html lang> unguarded on every render`).toMatch(/lastLang/);
    }
  });
});

/* ══ THE FILING VERBS SAY WHERE THE LETTER IS ═════════════════════════════════════════════ */

describe("the horizon buttons report the message's current pile (TRI-F12)", () => {
  const filed = (state: string) => ({
    triage: {
      messageId: "m1",
      state,
      bubbleUpAt: null,
      setAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z",
    },
  });
  const pressedOf = (label: string): string | null => verb(label)!.getAttribute("aria-pressed");

  it("the resurface PIN is not a pile — a resurfaced message presses nothing", () => {
    mountPanel(filed("resurfaced") as never, { visit: false });
    expect(pressedOf("Later")).toBe("false");
    expect(pressedOf("Park")).toBe("false");
    expect(pressedOf("Resurface")).toBe("false");
  });

  it("the press moves with the CURSOR — the next message does not inherit it", async () => {
    const { openOther } = mountPanel(filed("set_aside") as never, { others: [letter("m2", { unread: false })] });
    expect(pressedOf("Park")).toBe("true");
    await openOther("m2");
    expect(pressedOf("Park")).toBe("false");
  });

  it("…and drops when the message is UNFILED under the open reader", async () => {
    const { mail } = mountPanel(filed("reply_later") as never);
    expect(pressedOf("Later")).toBe("true");
    await act(() => mail.patch("m1", { triage: null }));
    expect(pressedOf("Later")).toBe("false");
  });
});

/* ══ DELETE ═══════════════════════════════════════════════════════════════════════════════
 *
 * RULED (`DIFFERENCES-FROM-TODAY.md`, the reader: "`d` opens the letter's More menu with Delete in it (one press
 * never deletes)"; the lists' finish, DECIDED 3): the new reader's ask is More itself. Delete is never on the panel;
 * opening More dispatches nothing; Delete in More is the deliberate second press. Where these cases opened today's
 * confirm strip they open More, and where they pressed the confirm they press More's Delete.
 */
describe("the Delete verb", () => {
  it("INVERTED (was: absent with the flag off) — it is PRESENT with no flag on the chrome", async () => {
    const { actions } = mountPanel();
    expect(shown()).not.toContain("Delete");
    await openMore();
    expect(actions, "opening the ask dispatched — the ask must come first").toEqual([]);
    expect(items("More")).toContain("Delete");
    await pressItem("More", "Delete");
    expect(actions).toEqual(["delete"]);
  });

  it("with the flag on it lives in More, opens the CONFIRM, and only the confirm dispatches", async () => {
    const { actions } = mountPanel();
    expect(shown()).not.toContain("Delete");
    await openMore();
    expect(actions).toEqual([]);
    expect(menu("More"), "the ask").not.toBeNull();
    await pressItem("More", "Delete");
    expect(actions).toEqual(["delete"]);
    expect(menu("More")).toBeNull();
  });

  it("a row NEITHER the mirror nor a page holds gets no Delete — and a History or Search row does", async () => {
    const { actions, drop } = mountPanel();
    await drop("m1", true);
    expect(screen.queryByRole("toolbar", { name: "Actions" }), "a letter nobody holds keeps a panel").toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(actions).toEqual([]);
  });

  it("a History or Search row the mirror does not hold still offers Delete, and its press dispatches", async () => {
    vi.useRealTimers();
    installShellEnv();
    try {
      const { host, calls } = await openStoreLetter();
      const deletes = () => calls.filter((call) => call === "delete");
      const actions = within(host).getByRole("toolbar", { name: "Actions" });
      await shellAct(async () => { within(actions).getByRole("button", { name: "More" }).click(); });
      expect(deletes()).toEqual([]);
      await shellAct(async () => { screen.getByRole("menuitem", { name: "Delete" }).click(); });
      expect(deletes()).toEqual([]);
      await tick(0);
      const report = host.querySelector(".fr-report")?.textContent;
      expect.soft(screen.queryByRole("button", { name: "Undo" }), report ?? "No report").not.toBeNull();
      await tick(UNDO_MS + 1_000);
      expect(deletes()).toEqual(["delete"]);
    } finally {
      await teardownShellEnv();
    }
  });

  it("Cancel dispatches nothing and restores the bar", async () => {
    const { actions } = mountPanel();
    await openMore();
    await key(menu("More")!, "Escape");
    expect(actions).toEqual([]);
    expect(menu("More")).toBeNull();
    expect(shown()).toContain("Reply");
  });

  it("INVERTED (was: the flag going off closes the strip) — an open confirm SURVIVES it", async () => {
    const { actions, mail } = mountPanel();
    await openMore();
    /* A change of the letter's row that does not take it away (the account's folders flag, today) is no gate. */
    await act(() => mail.patch("m1", { snippet: "the row changed under the open ask" }));
    expect(menu("More"), "a change of the row closed the open ask — it is not a gate on this verb").not.toBeNull();
    expect(actions).toEqual([]);
    await pressItem("More", "Delete");
    expect(actions).toEqual(["delete"]);
  });

  it("a STALE open confirm cannot dispatch after the MIRROR drops the row — the second gate", async () => {
    const { actions, drop } = mountPanel();
    await openMore();
    expect(menu("More")).not.toBeNull();
    await drop("m1", true);
    expect(menu("More")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(actions).toEqual([]);
    /* The row comes back: the ask does not come back with it on its own — it was withdrawn, not remembered. */
    await drop("m1", false);
    expect(menu("More"), "the ask came back on its own — the state was remembered, not withdrawn").toBeNull();
    expect(actions).toEqual([]);
  });
});

async function act(run: () => unknown): Promise<void> {
  const { act: reactAct } = await import("@testing-library/react");
  await reactAct(async () => {
    await run();
  });
}
