/** @vitest-environment jsdom */
/**
 * THE OLD SHELL'S COMPOSITION STANDS ONCE PER FRAME, ABOVE EVERY PANE. The real shell as the tests' door mounts it,
 * with the places every host hands: the Ohbox seated (a place of its own body), every other one of today's views. A
 * walk between the seated Ohbox and a view of today's mounts nothing of the composition a second time and asks the
 * consent wire nothing again; a send pressed before the walk is answered on the machine that sent it; and at the
 * seated Ohbox the app is whole: the rail, the notices, the palette, the key sheet and the way to the composer.
 *
 * Each part is counted live through a wrapper of its own module: the real hook or provider runs, the wrapper counts
 * its mounts.
 */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDraft, EngineMutation } from "@ohmail/client-engine";
import en from "../../messages/en.json";
import { act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";
import { settleEditor } from "../_first-paint.js";

type Part = "mailState" | "consentRow" | "composer" | "fileDoor" | "pictureDoor";
const seen = vi.hoisted(() => ({
  mounts: { mailState: 0, consentRow: 0, composer: 0, fileDoor: 0, pictureDoor: 0 },
  live: { mailState: 0, consentRow: 0, composer: 0, fileDoor: 0, pictureDoor: 0 },
  /** How often the consent wire's `state` was asked, on whichever wire object the row was handed. */
  asks: 0,
  wires: new WeakSet<object>(),
}));

vi.mock("@ohmail/app/mail-state", async (load) => {
  const real = await load<typeof import("@ohmail/app/mail-state")>();
  const { createElement, useEffect } = await import("react");
  function Counted(props: Parameters<typeof real.MailStateProvider>[0]) {
    useEffect(() => {
      seen.mounts.mailState += 1;
      seen.live.mailState += 1;
      return () => {
        seen.live.mailState -= 1;
      };
    }, []);
    return createElement(real.MailStateProvider, props);
  }
  return { ...real, MailStateProvider: Counted };
});

vi.mock("@ohmail/app-logic/consent/consent-state", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/consent/consent-state")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useConsentState: (...args: Parameters<typeof real.useConsentState>) => {
      /* The wire the row is handed, counted where it is asked: its `state` is wrapped once per wire object. */
      const wire = args[2] as unknown as { state?: (...a: unknown[]) => unknown } | string;
      if (typeof wire === "object" && typeof wire.state === "function" && !seen.wires.has(wire)) {
        seen.wires.add(wire);
        const asked = wire.state;
        wire.state = (...a: unknown[]) => {
          seen.asks += 1;
          return asked.apply(wire, a);
        };
      }
      const row = real.useConsentState(...args);
      useEffect(() => {
        seen.mounts.consentRow += 1;
        seen.live.consentRow += 1;
        return () => {
          seen.live.consentRow -= 1;
        };
      }, []);
      return row;
    },
  };
});

vi.mock("../../app/shell/shell-compose", async (load) => {
  const real = await load<typeof import("../../app/shell/shell-compose")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useShellCompose: (...args: Parameters<typeof real.useShellCompose>) => {
      const composer = real.useShellCompose(...args);
      useEffect(() => {
        seen.mounts.composer += 1;
        seen.live.composer += 1;
        return () => {
          seen.live.composer -= 1;
        };
      }, []);
      return composer;
    },
  };
});

vi.mock("../../app/shell/attachments", async (load) => {
  const real = await load<typeof import("../../app/shell/attachments")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useMessageAttachments: (...args: Parameters<typeof real.useMessageAttachments>) => {
      const door = real.useMessageAttachments(...args);
      useEffect(() => {
        seen.mounts.fileDoor += 1;
        seen.live.fileDoor += 1;
        return () => {
          seen.live.fileDoor -= 1;
        };
      }, []);
      return door;
    },
  };
});

vi.mock("../../app/shell/remote-images", async (load) => {
  const real = await load<typeof import("../../app/shell/remote-images")>();
  const { useEffect } = await import("react");
  return {
    ...real,
    useRemoteImages: (...args: Parameters<typeof real.useRemoteImages>) => {
      const door = real.useRemoteImages(...args);
      useEffect(() => {
        seen.mounts.pictureDoor += 1;
        seen.live.pictureDoor += 1;
        return () => {
          seen.live.pictureDoor -= 1;
        };
      }, []);
      return door;
    },
  };
});

const ONCE: Record<Part, number> = { mailState: 1, consentRow: 1, composer: 1, fileDoor: 1, pictureDoor: 1 };

const letter = {
  id: "d-letter", mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Shall we meet at noon?",
  to: [{ name: "Mila", address: "mila@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft;

const SENDING = en.sendingLine.sending.replace("{name}", "Mila");
const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
/** What the one notice slot says in full now: the notice in front, its words and its answers. */
const said = (): string => screen.queryAllByRole("status").map((notice) => notice.textContent ?? "").join(" | ");
const saysSending = (): boolean => said().includes(SENDING);
const saysOfMila = (): boolean => said().includes("Mila");
/** The seated Ohbox is on screen: the frame draws its reading column. A view of today's stands in the wide pane. */
const atTheOhbox = (): boolean => screen.queryByRole("region", { name: "Reading" }) !== null;
const TODAYS_ADDRESS = "#/history";
const subject = (): HTMLElement | null => screen.queryByRole("textbox", { name: en.compose.subject });
/** How many entries the rail today's views feed holds; none where no fed rail stands. */
const fedRailEntries = (): number => {
  const rail = screen.queryByRole("navigation", { name: "Main" });
  return rail === null ? 0 : within(rail).queryAllByRole("button").length;
};

async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}
async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}
/** Hold the next send on the wire; the answer leaves when the returned function is called. */
function holdTheSend(s: DraftShell): () => void {
  let release!: () => void;
  s.sendGate.wait = new Promise<void>((r) => { release = r; });
  return () => {
    s.sendGate.wait = null;
    release();
  };
}
/** The letter from Drafts into the composer, Send pressed, the composer handed off with the send still on the wire. */
async function sendTheLetter(s: DraftShell): Promise<() => void> {
  const open = () => within(s.el).queryByRole("button", { name: /Plans for Friday/ });
  await waitFor(() => open() !== null, "the letter in Drafts");
  await press(open(), "open the letter");
  await waitFor(() => (subject() as HTMLInputElement | null)?.value === "Plans for Friday", "the composer on the letter");
  const release = holdTheSend(s);
  const send = within(s.el).getAllByRole("button").find((b) => /^Send(?! later)/.test((b.textContent ?? "").trim()));
  await press(send ?? null, "Send");
  await waitFor(() => sends(s).length === 1, "the send on the wire");
  await waitFor(() => subject() === null, "the composer handed off");
  return release;
}

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  for (const part of Object.keys(ONCE) as Part[]) {
    seen.mounts[part] = 0;
    seen.live[part] = 0;
  }
  seen.asks = 0;
});
afterEach(async () => {
  await unmountAll();
});

describe("the old shell's composition over a walk from the seated Ohbox to a view of today's and back", () => {
  it("mounts the mail state, the consent row, the composer and the two doors once, and asks the consent wire once", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox with its letter");
    await rounds(8);
    expect({ mounts: { ...seen.mounts }, live: { ...seen.live }, asks: seen.asks }, "as the frame mounted").toEqual({
      mounts: ONCE, live: ONCE, asks: 1,
    });

    await visit(TODAYS_ADDRESS);
    await waitFor(() => !atTheOhbox(), "History, a view of today's");
    await rounds(8);
    expect({ ...seen.live }, "at a view of today's every part still stands, once").toEqual(ONCE);

    await visit("#/ohbox");
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox again");
    await rounds(8);
    expect({ mounts: { ...seen.mounts }, live: { ...seen.live }, asks: seen.asks }, "after the walk").toEqual({
      mounts: ONCE, live: ONCE, asks: 1,
    });
  }, 60_000);

  it("a send pressed before the walk is one send, answered on the machine that sent it, its notice gone", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    const release = await sendTheLetter(s);
    await waitFor(saysSending, "the notice says the send is on its way");

    await visit("#/ohbox");
    await waitFor(atTheOhbox, "the seated Ohbox");
    await rounds(8);
    expect(saysSending(), "at the seated Ohbox the notice still says the send is on its way").toBe(true);

    await act(async () => { release(); });
    await waitFor(() => !saysSending() && saysOfMila(), "the answer applied: the notice says it went");
    await waitFor(() => !saysOfMila(), "the notice settles away", 400);

    await visit(TODAYS_ADDRESS);
    await waitFor(() => !atTheOhbox(), "a view of today's again");
    await rounds(20);
    expect(sends(s), "one send left for one press").toHaveLength(1);
    expect({ ...seen.mounts }, "nothing of the composition was mounted again").toEqual(ONCE);
  }, 60_000);
});

describe("at the seated Ohbox the app is whole", () => {
  it("the fed rail, a notice of today's feeds, the palette, the key sheet and the way to the composer stand; today's reader sheet does not", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    const release = await sendTheLetter(s);
    await visit(TODAYS_ADDRESS);
    await waitFor(() => !atTheOhbox() && fedRailEntries() > 0, "History beside its fed rail");
    await waitFor(saysSending, "the notice says the send is on its way");
    const entries = fedRailEntries();
    expect(entries, "a view of today's stands beside a fed rail").toBeGreaterThan(0);

    await visit("#/ohbox");
    await waitFor(() => atTheOhbox() && within(s.el).queryAllByRole("option").length > 0, "the seated Ohbox");
    await rounds(8);
    expect({ rail: fedRailEntries(), notice: saysSending() }, "the rail and the notice at the seated Ohbox").toEqual({
      rail: entries, notice: true,
    });
    expect(screen.queryByRole("dialog", { name: en.reader.pane, hidden: true }), "today's reader sheet").toBeNull();

    await key("k", { ctrlKey: true });
    await waitFor(() => screen.queryByRole("dialog", { name: en.palette.ariaLabel }) !== null, "the palette's key opens it");
    await key("Escape");
    await waitFor(() => screen.queryByRole("dialog", { name: en.palette.ariaLabel }) === null, "the palette closed");

    await key("?");
    await waitFor(() => screen.queryByRole("dialog", { name: en.shortcuts.title }) !== null, "? opens the key sheet");
    await key("Escape");
    await waitFor(() => screen.queryByRole("dialog", { name: en.shortcuts.title }) === null, "the key sheet closed");

    await key("c");
    await waitFor(() => subject() !== null, "c reaches the composer");
    expect(atTheOhbox(), "the composer stands in place of the seated Ohbox").toBe(false);

    await act(async () => { release(); });
    await waitFor(() => !saysOfMila(), "the send's notice settles away", 400);
  }, 60_000);
});
