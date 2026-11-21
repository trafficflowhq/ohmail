/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUNK_SEARCH_DEBOUNCE_MS, type JunkWire } from "@ohmail/app-logic/screener/junk-window";
import type { JunkItemWire, JunkPageWire, JunkSweepWire } from "../app/api-client.js";
import de from "../messages/de.json";
import {
  ISO, act, answerConsentWith, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell.js";

let host: HTMLElement;
const mine = { id: "mb1", address: "a@example.invalid", window: "ok" } as const;
const other = { id: "mb2", address: "b@example.invalid" } as const;
const noSweep: JunkSweepWire = { mailboxes: [], movable: 0, pending: false };

function item(over: Partial<JunkItemWire> & { uid: number }): JunkItemWire {
  return {
    mailboxId: "mb1",
    uidValidity: "7",
    subject: `junk ${over.uid}`,
    from: { name: null, address: `s${over.uid}@example.invalid` },
    date: new Date(Date.UTC(2026, 7, 1) + over.uid * 60_000).toISOString(),
    messageIdHeader: `<mid-${over.uid}@x>`,
    seen: false,
    origin: "provider",
    ...over,
  };
}

function wire(over: Partial<JunkPageWire> = {}) {
  return {
    list: vi.fn<JunkWire["list"]>().mockResolvedValue({ mailboxes: [mine], items: [], nextCursor: null, ...over }),
    body: vi.fn<JunkWire["body"]>().mockResolvedValue({ subject: "", text: "Buy now." }),
    rescue: vi.fn<JunkWire["rescue"]>().mockResolvedValue({ status: "queued", rescueId: "rescue-1" }),
    dismissRescue: vi.fn<JunkWire["dismissRescue"]>().mockResolvedValue({}),
    search: vi.fn<JunkWire["search"]>().mockResolvedValue({ mailboxes: [], items: [], truncated: false }),
    sweepPreview: vi.fn<JunkWire["sweepPreview"]>().mockResolvedValue(noSweep),
    sweepRequest: vi.fn<JunkWire["sweepRequest"]>().mockResolvedValue(noSweep),
    isGone: () => false,
    codeOf: () => null,
  } satisfies JunkWire;
}

function installJunkEnv(): void {
  installShellEnv();
  vi.stubGlobal("innerWidth", 1280);
  answerConsentWith({ foldersEnabledAt: ISO });
}
beforeEach(installJunkEnv);

async function unmount(): Promise<void> {
  await teardownShellEnv();
  vi.unstubAllGlobals();
}
afterEach(unmount);

async function remount(): Promise<void> {
  await unmount();
  installJunkEnv();
}

async function mount(junkWire: JunkWire | "none", locale: "en" | "de" = "en"): Promise<void> {
  host = await mountShell([mailbox({ id: mine.id, address: mine.address, lastSyncAt: ISO })], {
    junkWire, locale, suggestWire: "none",
  });
  await goTo("screener/spam");
  await tick(50);
}

async function resize(width: number): Promise<void> {
  await act(async () => {
    vi.stubGlobal("innerWidth", width);
    window.dispatchEvent(new Event("resize"));
  });
  await tick(0);
}

const button = (name: string) => within(host).queryByRole("button", { name });
const tabs = () => within(host).getAllByRole("button", { pressed: true }).map((b) => b.textContent?.trim());
const rows = () => within(within(host).getByRole("listbox", { name: "Junk" })).getAllByRole("option");
const click = async (control: HTMLElement | null) => {
  expect(control, "expected a control to click").not.toBeNull();
  await act(async () => { fireEvent.click(control!); });
  await tick(0);
};
const query = async (value: string) => {
  await act(async () => {
    fireEvent.input(within(host).getByRole("searchbox", { name: "Search your Junk folder" }), { target: { value } });
  });
  await tick(0);
};
const fingerprint = (count: number) => String(count).padStart(43, "0");
const preview = (movable: number, pending = false): JunkSweepWire => ({
  mailboxes: [{ ...mine, candidates: movable, hasJunkFolder: true, pending }],
  movable, pending, confirmation: fingerprint(movable),
});

describe("flag-off parity (§16.7)", () => {
  it("without the junk control the third segment is still SPAM over the mirror pile", async () => {
    answerSyncWith(() => page(1));
    await mount("none");
    expect(tabs()).toContain("Spam");
    expect(button("Junk")).toBeNull();
    expect(host.textContent?.match(/Nothing here/g)).toHaveLength(1);
  });
});

describe("the live window", () => {
  it("renames the segment to Junk and renders each row with its ORIGIN marker", async () => {
    await mount(wire({ items: [item({ uid: 2, origin: "verdict" }), item({ uid: 1, origin: "provider" })] }));
    expect(within(host).getByRole("button", { name: "Spam 2", pressed: true })).toBeTruthy();
    expect(button("Junk")).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(rows().map((r) => r.textContent).join(" ")).toContain("Your verdict");
    expect(rows().map((r) => r.textContent).join(" ")).toContain("Mail server");
    expect(within(host).getByText(/on its own schedule/).textContent).not.toMatch(/\d/);
  });

  it("LOADING is a stated state — no rows, and no claim of emptiness", async () => {
    const junk = wire();
    junk.list.mockImplementation(() => new Promise(() => {}));
    await mount(junk);
    expect(host.textContent).toContain("Reading your mail server's Junk folder");
    expect(within(host).queryByRole("listbox", { name: "Junk" })).toBeNull();
    expect(host.textContent).not.toContain("Junk is empty");
  });

  it("FAILED renders the failed sentence and a human retry — NEVER the empty state", async () => {
    const junk = wire();
    junk.list.mockRejectedValue(new Error("Junk unavailable"));
    await mount(junk);
    expect(host.textContent).toContain("Junk couldn't be read just now");
    expect(host.textContent).not.toContain("Junk is empty");
    const before = junk.list.mock.calls.length;
    await click(button("Try again"));
    expect(junk.list).toHaveBeenCalledTimes(before + 1);
  });

  it("in German the window is the Spam-Ordner, and the English word Junk is nowhere on it", async () => {
    await mount(wire(), "de");
    expect(tabs()).toContain(de.screener.segSpam);
    expect(host.textContent).toContain(de.screener.place.empty.junk);
    expect(within(host).getByRole("searchbox").getAttribute("placeholder")).toBe(de.screener.junkSearchPlaceholder);
    const said = [host.textContent ?? "", ...[...host.querySelectorAll("[aria-label], [placeholder]")]
      .flatMap((el) => [el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? ""])];
    expect(said.filter((s) => /\bJunk\b/.test(s))).toEqual([]);
  });

  it("an empty READY window says Junk is empty — an answer, not a fallback", async () => {
    await mount(wire());
    expect(host.textContent).toContain("Junk is empty");
  });

  it("a mailbox with no native \\Junk is NAMED, beside whatever did load", async () => {
    await mount(wire({
      items: [item({ uid: 3 })],
      mailboxes: [mine, { ...other, window: "no_junk_folder" }],
    }));
    expect(host.textContent).toContain("b@example.invalid has no Junk folder of its own");
    expect(rows()).toHaveLength(1);
  });

  it("Show older appears exactly while there is an older page, and dispatches loadOlder", async () => {
    const junk = wire({ items: [item({ uid: 9 })], nextCursor: "abc" });
    junk.list.mockResolvedValueOnce({ mailboxes: [mine], items: [item({ uid: 9 })], nextCursor: "abc" })
      .mockResolvedValue({ mailboxes: [mine], items: [item({ uid: 8 })], nextCursor: null });
    await mount(junk);
    expect(junk.list.mock.calls.filter(([opts]) => opts?.cursor)).toEqual([]);
    await click(button("Show older"));
    expect(junk.list.mock.calls.filter(([opts]) => opts?.cursor)).toEqual([[{ cursor: "abc" }]]);
    expect(button("Show older")).toBeNull();
  });
});

describe("the honest empty claim and the mobile gestures (UI review round)", () => {
  it("ZERO items beside an UNREACHABLE mailbox is NOT 'Junk is empty'", async () => {
    await mount(wire({ mailboxes: [mine, { ...other, window: "unreachable" }] }));
    expect(host.textContent).not.toContain("Junk is empty");
    expect(host.textContent).toContain("b@example.invalid couldn't be read just now.");
  });

  it("on a NARROW viewport a row tap opens the full preview — the read column is hidden until it does", async () => {
    await resize(390);
    await mount(wire({ items: [item({ uid: 5 })] }));
    expect(button("Not junk")).toBeNull();
    await click(rows()[0]!);
    expect(button("Not junk")).toBeTruthy();
  });

  it("on a NARROW viewport no body is fetched until the preview is OPEN — body-on-open, §16.2", async () => {
    await resize(390);
    const junk = wire({ items: [item({ uid: 5 })] });
    await mount(junk);
    expect(junk.body).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Loading the full message");
    await click(rows()[0]!);
    expect(junk.body.mock.calls).toEqual([["mb1", 5, "7"]]);
  });

  it("WIDENING the viewport reveals the read column AND fetches the selection's body", async () => {
    await resize(390);
    const junk = wire({ items: [item({ uid: 5 })] });
    await mount(junk);
    expect(junk.body).not.toHaveBeenCalled();
    await resize(1280);
    expect(junk.body.mock.calls).toEqual([["mb1", 5, "7"]]);
    expect(button("Not junk")).toBeTruthy();
  });
});

describe("the preview and the rescue", () => {
  it("the selected row opens its body (session-cached fetch) and renders it as text", async () => {
    const junk = wire({ items: [item({ uid: 5 })] });
    await mount(junk);
    expect(junk.body.mock.calls).toEqual([["mb1", 5, "7"]]);
    expect(host.textContent).toContain("Buy now.");
    await click(rows()[0]!);
    expect(junk.body.mock.calls).toEqual([["mb1", 5, "7"]]);
  });

  it("Not junk dispatches the rescue for the SELECTED row, with the honest note beside it", async () => {
    const junk = wire({ items: [item({ uid: 5 }), item({ uid: 4 })] });
    await mount(junk);
    expect(host.textContent).not.toContain("a first-time sender waits in the Screener");
    await click(button("Not junk"));
    expect(junk.rescue.mock.calls).toEqual([["mb1", 5, "7", {}]]);
  });
});

describe("the second verb — Not junk, always allow", () => {
  it("is a SECOND button on the selected row, and dispatches the rescue WITH the allow flag", async () => {
    const junk = wire({ items: [item({ uid: 5 }), item({ uid: 4 })] });
    // A refused command keeps the same row in Junk, so its plain verb can still be pressed.
    junk.rescue.mockRejectedValueOnce(new Error("command refused"));
    await mount(junk);
    expect(host.textContent).not.toContain("their spam rule is switched off");
    await click(button("Not junk, always allow"));
    expect(junk.rescue.mock.calls).toEqual([["mb1", 5, "7", { allow: { sender: "s5@example.invalid" } }]]);
    await click(button("Not junk"));
    expect(junk.rescue.mock.calls).toEqual([
      ["mb1", 5, "7", { allow: { sender: "s5@example.invalid" } }],
      ["mb1", 5, "7", {}],
    ]);
  });
});

describe("the search-append's rendering", () => {
  it("the field hands every keystroke to the control", async () => {
    const junk = wire({ items: [item({ uid: 5, subject: "acme invoice" }), item({ uid: 4, subject: "another offer" })] });
    await mount(junk);
    for (const part of ["a", "ac", "acm", "acme"]) {
      await query(part);
      expect(within(host).getByRole("searchbox")).toHaveProperty("value", part);
    }
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("acme invoice");
    expect(junk.search).not.toHaveBeenCalled();
  });

  it("SEARCHING is a stated state, and the appended hits sit under their own caption", async () => {
    const junk = wire({ items: [item({ uid: 5, subject: "acme invoice" })], nextCursor: "abc" });
    let answer: ((result: Awaited<ReturnType<JunkWire["search"]>>) => void) | undefined;
    junk.search.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await mount(junk);
    await query("acme");
    await click(button("Also search your mail server"));
    expect(host.textContent).toContain("Searching your mail server's Junk folder for “acme”…");
    expect(host.textContent).not.toContain("Found on your mail server");
    expect(junk.search.mock.calls).toEqual([["acme"]]);
    await act(async () => {
      answer!({
        items: [item({ uid: 1, subject: "older acme" })],
        mailboxes: [mine, { ...other, window: "unreachable" }],
        truncated: true,
      });
    });
    expect(within(host).getByRole("listbox", { name: "Found on your mail server" }).textContent).toContain("older acme");
    expect(host.textContent).toContain("b@example.invalid couldn't be searched in time.");
    expect(host.textContent).toContain("These are the newest matches. Narrow the search to reach older ones.");
    expect(button("Show older")).toBeNull();
  });

  it("NOTHING FOUND says so plainly; a FAILED search offers the retry; local matches offer the server", async () => {
    const junk = wire({ items: [item({ uid: 5, subject: "acme" })] });
    await mount(junk);
    await query("zzz");
    await tick(JUNK_SEARCH_DEBOUNCE_MS);
    expect(host.textContent).toContain("Nothing in Junk matches “zzz”.");
    expect(host.textContent).not.toContain("Junk is empty");

    junk.search.mockRejectedValueOnce(new Error("search unavailable"));
    await query("other");
    await tick(JUNK_SEARCH_DEBOUNCE_MS);
    expect(host.textContent).toContain("Junk couldn't be searched just now.");
    const beforeRetry = junk.search.mock.calls.length;
    await click(button("Search again"));
    expect(junk.search).toHaveBeenCalledTimes(beforeRetry + 1);
    expect(junk.search).toHaveBeenLastCalledWith("other");

    await query("acme");
    const beforeServer = junk.search.mock.calls.length;
    await click(button("Also search your mail server"));
    expect(junk.search).toHaveBeenCalledTimes(beforeServer + 1);
    expect(junk.search).toHaveBeenLastCalledWith("acme");
  });
});

describe("the one-time sweep offer", () => {
  it("offers the pile with its NUMBER, asks once more, then records the press; Dismiss dismisses", async () => {
    const junk = wire();
    junk.sweepPreview.mockResolvedValue(preview(3));
    await mount(junk);
    expect(junk.sweepPreview).toHaveBeenCalled();
    expect(host.textContent).toContain("3 messages are still in ohmail/Quarantine");
    expect(junk.sweepRequest).not.toHaveBeenCalled();
    await click(button("Move to Junk"));
    expect(junk.sweepRequest).not.toHaveBeenCalled();
    await click(button("Move 3 messages"));
    expect(junk.sweepRequest.mock.calls).toEqual([[fingerprint(3)]]);

    await remount();
    const again = wire();
    again.sweepPreview.mockResolvedValue(preview(1));
    await mount(again);
    expect(host.textContent).toContain("1 message is still in ohmail/Quarantine");
    await click(button("Dismiss"));
    expect(host.textContent).not.toContain("1 message is still in ohmail/Quarantine");
    expect(again.sweepRequest).not.toHaveBeenCalled();

    await remount();
    const earlier = wire();
    earlier.sweepPreview.mockResolvedValue({ ...preview(2), confirmationRequired: true });
    await mount(earlier);
    expect(host.textContent).not.toContain("Your previous Quarantine move needs a new confirmation.");
    expect(earlier.sweepRequest).not.toHaveBeenCalled();
    await click(button("Move to Junk"));
    expect(within(document.body).getByRole("dialog", { name: "Move to Junk" }).textContent).toContain(
      "They move to your mail server's Junk folder, and ohmail does not move them back.",
    );
    expect(earlier.sweepRequest).not.toHaveBeenCalled();
    await click(button("Move 2 messages"));
    expect(earlier.sweepRequest.mock.calls).toEqual([[fingerprint(2)]]);
  });

  it("QUEUED and DONE are read back, a stranded mailbox is named, and no offer renders on a guess", async () => {
    const pending = wire();
    pending.sweepPreview.mockResolvedValue(preview(2, true));
    await mount(pending);
    expect(pending.sweepPreview).toHaveBeenCalled();
    expect(host.textContent).toContain("The move is queued and happens in the next few minutes.");
    expect(button("Move to Junk")).toBeNull();

    await remount();
    const done = wire();
    done.sweepPreview.mockResolvedValue(preview(2));
    await mount(done);
    await click(button("Move to Junk"));
    await click(button("Move 2 messages"));
    expect(host.textContent).toContain("ohmail/Quarantine is empty");
    expect(host.textContent).toContain("The 2 messages are in your mail server's Junk folder now.");

    await remount();
    const stranded = wire();
    stranded.sweepPreview.mockResolvedValue({
      mailboxes: [...preview(2).mailboxes, { ...other, candidates: 4, hasJunkFolder: false, pending: false }],
      movable: 2, pending: false, confirmation: fingerprint(2),
    });
    await mount(stranded);
    expect(host.textContent).toContain("2 messages are still in ohmail/Quarantine");
    expect(host.textContent).toContain("4 messages stay in ohmail/Quarantine");
    expect(host.textContent).toContain("b@example.invalid has no Junk folder, so they stay where they are.");

    await remount();
    const unknown = wire();
    unknown.sweepPreview.mockRejectedValue(new Error("no preview"));
    await mount(unknown);
    expect(button("Move to Junk")).toBeNull();
    expect(host.textContent).not.toContain("still in ohmail/Quarantine");
  });
});

describe("the sweep offer — a STRANDED pile (client review round 1)", () => {
  it("names what stays and offers NOTHING to press — never 'Done', never 'Move to Junk'", async () => {
    const junk = wire();
    junk.sweepPreview.mockResolvedValue({
      mailboxes: [{ ...other, candidates: 4, hasJunkFolder: false, pending: false }],
      movable: 0, pending: false,
    });
    await mount(junk);
    expect(junk.sweepPreview).toHaveBeenCalled();
    expect(host.textContent).toContain("4 messages stay in ohmail/Quarantine");
    expect(host.textContent).toContain("b@example.invalid has no Junk folder, so they stay where they are.");
    expect(host.textContent).not.toContain("ohmail/Quarantine is empty");
    expect(button("Move to Junk")).toBeNull();
  });
});
