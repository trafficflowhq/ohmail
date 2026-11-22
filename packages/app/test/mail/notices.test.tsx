/** @vitest-environment jsdom */
/**
 * THE MAIL'S NOTICES ON THE GROUND (`MailNotices`), and THE RESTART HOLD'S RELAY beside it.
 *
 * THE UPDATE NOTICE: a newer ohmail is said in the frame's one notice slot with the version that is ready, and its
 * one press restarts or reloads. An open editor's words are written first. While a send waits, or a draft holds
 * files, it says which and offers no press; a hold that began while the words were written stops the press.
 *
 * THE RELAY: a send that is queued or on its way holds the restart at `send` for as long as the relay stands over
 * the send machine. Without the relay nothing would hold it, and an update would drop the letter.
 *
 * THE STORAGE-REFUSED NOTICE: a write this browser refused is said in the slot, once per session: put away, it does
 * not come back with the next refused write.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceUpdate,
  holdFilesForRestart,
  holdForRestart,
  resetUpdateStoreForTests,
  restartHold,
  setSendWaits,
  type UpdateOffer,
} from "@ohmail/app-logic/doors/app-update";
import { durableSet, resetDurabilityForTest } from "@ohmail/app-logic/storage/durable";
import type { MailSendApi, SendLineItem, SendState } from "@ohmail/app-logic/writing/mail-send";
import type { FramePlaces } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { SendWaitsRelay } from "../../src/mail/ground/SendWaitsRelay.js";
import { sendingNotice } from "../../src/mail/ground/send-notices.js";
import { unsavedTitle } from "../../src/mail/ground/UnsavedList.js";
import { MailGround } from "../../src/mail/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import frameEn from "../../messages/frame.en.json" with { type: "json" };

/** The mail's words with the frame's whole place file, where the update's sentences stand. */
const MESSAGES = { ...WORDS.en, ...frameEn } as Messages;
/** What a person is told of a browser that keeps no decisions, and the one answer to it. */
const NOT_KEPT = doorsEn.session.storageRefused;

const PLACES: Partial<FramePlaces> = {
  ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => <p>the Ohbox</p> } },
};

/** A send machine as the relay reads it: what stands on its line, and the composer's own send. */
function machine() {
  let items: readonly SendLineItem[] = [];
  let compose: SendState["phase"] = "idle";
  let version = 0;
  const told = new Set<() => void>();
  const tell = (): void => {
    version += 1;
    for (const one of [...told]) one();
  };
  const api: Pick<MailSendApi, "line" | "subscribeLine" | "lineVersion" | "stateOf"> = {
    line: () => items,
    subscribeLine: (changed) => {
      told.add(changed);
      return () => told.delete(changed);
    },
    lineVersion: () => version,
    stateOf: () => ({ phase: compose }) as SendState,
  };
  return {
    api,
    line: (next: readonly SendLineItem[]) => {
      items = next;
      tell();
    },
    composer: (phase: SendState["phase"]) => {
      compose = phase;
      tell();
    },
  };
}
const item = (state: SendLineItem["state"]): SendLineItem => ({
  id: "s1",
  key: "re:m1",
  state,
  to: "Lena",
  subject: "Plans",
});

/** The frame over the ground, and beside it the relay over a machine where a case stands one. */
function mount(relay: ReturnType<typeof machine> | null = null) {
  const { host } = fakeHost({
    engine: fakeMail([letter("m1")]).engine,
    service: "self",
    scope: "acct-1",
    places: PLACES,
    above: MailGround,
    address: fakeAddress("#/ohbox"),
  });
  return render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="Europe/Zurich">
      {relay ? <SendWaitsRelay api={relay.api} /> : null}
      <Frame host={host} />
    </TextProvider>,
  );
}
const offer = (kind: UpdateOffer["kind"], act: () => void): UpdateOffer =>
  ({ kind, version: "2.0.1", act }) as UpdateOffer;
const announce = (next: UpdateOffer) => act(async () => announceUpdate(next));
const verb = (name: string) => screen.queryByRole("button", { name });
const turn = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

beforeEach(() => {
  localStorage.clear();
  resetUpdateStoreForTests();
  resetDurabilityForTest();
  setSendWaits(false);
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  resetUpdateStoreForTests();
  setSendWaits(false);
});

describe("the update notice on the ground", () => {
  it("says the version that is ready, and Restart restarts once", async () => {
    mount();
    const restart = vi.fn();
    await announce(offer("ready", restart));
    expect(screen.getByText(/2\.0\.1/)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restart" })));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("writes an open editor's words before Restart restarts", async () => {
    mount();
    const order: string[] = [];
    const release = holdForRestart(async () => void order.push("written"));
    await announce(offer("ready", () => void order.push("restarted")));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restart" })));
    await turn();
    expect(order).toEqual(["written", "restarted"]);
    release();
  });

  it("writes an open editor's words before Reload reloads", async () => {
    mount();
    const order: string[] = [];
    const release = holdForRestart(async () => void order.push("written"));
    await announce(offer("reload", () => void order.push("reloaded")));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Reload" })));
    await turn();
    expect(order).toEqual(["written", "reloaded"]);
    release();
  });

  it("leaves the restart uncalled when a hold begins while the editor's words are written", async () => {
    mount();
    const restart = vi.fn();
    let drop = (): void => {};
    /* The editor takes files while its words are written: a hold that was not there when Restart was pressed. */
    const release = holdForRestart(async () => {
      drop = holdFilesForRestart();
    });
    await announce(offer("ready", restart));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Restart" })));
    await turn();
    expect(restart, "the restart dropped the files the editor took meanwhile").not.toHaveBeenCalled();
    release();
    drop();
  });

  it("while a draft holds files it says so and offers no Restart, and the verb is back when they are let go", async () => {
    mount();
    const drop = holdFilesForRestart();
    await announce(offer("ready", () => undefined));
    expect(verb("Restart")).toBeNull();
    expect(screen.getByText("after your draft's files are sent or removed")).toBeTruthy();
    await act(async () => drop());
    expect(verb("Restart")).not.toBeNull();
  });

  it("Later puts the offer away", async () => {
    mount();
    await announce(offer("ready", () => undefined));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Not now" })));
    expect(screen.queryByText(/2\.0\.1/)).toBeNull();
  });
});

describe("the restart hold's relay over the send machine", () => {
  it("a send queued holds the restart at send, and the hold goes when the send has gone", async () => {
    const sends = machine();
    mount(sends);
    expect(restartHold()).toBeNull();
    await act(async () => sends.line([item("queued")]));
    expect(restartHold()).toBe("send");
    await act(async () => sends.line([item("sent")]));
    expect(restartHold()).toBeNull();
  });

  it("a send on its way holds it, and so does the composer's own send before it stands on the line", async () => {
    const sends = machine();
    mount(sends);
    await act(async () => sends.line([item("sending")]));
    expect(restartHold()).toBe("send");
    await act(async () => sends.line([]));
    expect(restartHold()).toBeNull();
    await act(async () => sends.composer("queued"));
    expect(restartHold()).toBe("send");
  });

  it("with a send queued the update notice offers no Restart and no Reload, and says it waits for the letter", async () => {
    const sends = machine();
    mount(sends);
    const restart = vi.fn();
    await act(async () => sends.line([item("queued")]));
    await announce(offer("ready", restart));
    expect(verb("Restart")).toBeNull();
    expect(screen.getByText("after your letter is sent")).toBeTruthy();
    await announce(offer("reload", restart));
    expect(verb("Reload")).toBeNull();
    /* The letter has gone: the press is offered again, and restarts. */
    await act(async () => sends.line([item("sent")]));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Reload" })));
    await turn();
    expect(restart).toHaveBeenCalledOnce();
  });

  it("the relay gone, it says no send waits: nothing of a frame that left holds the next one", async () => {
    const sends = machine();
    const view = mount(sends);
    await act(async () => sends.line([item("queued")]));
    expect(restartHold()).toBe("send");
    view.unmount();
    expect(restartHold()).toBeNull();
  });
});

describe("the storage-refused notice on the ground", () => {
  /** The notice in the slot that offers its one answer, or null. */
  const notKept = (): HTMLElement | null =>
    screen.queryByRole("button", { name: "Dismiss" })?.closest<HTMLElement>('[role="status"]') ?? null;

  it("a write this browser refuses is said in the slot; Dismiss puts it away, and the next refusal does not bring it back", async () => {
    mount();
    expect(notKept(), "said while every write lands").toBeNull();
    const refuse = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      await act(async () => void durableSet("k", "v", "probe"));
      expect(notKept()?.textContent).toContain(NOT_KEPT);
      await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Dismiss" })));
      expect(notKept()).toBeNull();
      await act(async () => void durableSet("k2", "v", "probe"));
      expect(notKept(), "a dismissed notice came back").toBeNull();
    } finally {
      refuse.mockRestore();
    }
  });

  it("a write refused before the frame came up is said as it comes up", async () => {
    const refuse = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      durableSet("k", "v", "probe");
    } finally {
      refuse.mockRestore();
    }
    mount();
    await act(async () => {});
    expect(notKept()?.textContent).toContain(NOT_KEPT);
  });
});

describe("the send machine's lines as the slot's notices", () => {
  /* The words by key, with what each names: which sentence a notice says is the subject here, not its wording. */
  const t = (key: string, values?: Record<string, string | number>): string =>
    values === undefined ? key : `${key} ${JSON.stringify(values)}`;
  const ended = (key: string, to: string | null, subject: string | null): SendLineItem => ({
    id: `e:${key}`,
    key,
    state: "ended",
    to,
    subject,
    ended: { phase: "failed", reason: "refused" } as SendState,
  });
  const opened: string[][] = [];
  const open = (items: readonly SendLineItem[]): void => void opened.push(items.map((i) => i.id));

  it("a letter that did not leave is said hot, with whom and what it was for and that it was not sent, and Open leads back to it", () => {
    opened.length = 0;
    const notice = sendingNotice(t, [ended("re:m1", "Lena", "Plans")], open)!;
    expect(notice.kind).toBe("notSent");
    expect(notice.hot).toBe(true);
    expect(notice.title).toBe('sendingLine.aboutBoth {"name":"Lena","subject":"Plans"}');
    expect(notice.line, "the sentence that says it did not leave").toMatch(/^reply\.status/);
    expect(notice.acts?.map((a) => a.label)).toEqual(["sendingLine.open"]);
    notice.acts![0]!.onPress();
    expect(opened).toEqual([["e:re:m1"]]);
  });

  it("a letter named by nobody is said by its sentence alone; a new letter's in the letter's own words", () => {
    expect(sendingNotice(t, [ended("re:m1", null, null)], open)!.title).toMatch(/^reply\.status/);
    expect(sendingNotice(t, [ended("compose", "Lena", null)], open)!.line).toMatch(/^compose\.status/);
  });

  it("several that did not leave are counted, and Open leads to where they are kept", () => {
    opened.length = 0;
    const items = [ended("re:m1", "Lena", "Plans"), ended("re:m2", "Ben", "Kiln")].map((i, n) => ({
      ...i,
      left: { rowId: `d${n}`, aboutThisCompose: false },
    }));
    const notice = sendingNotice(t, items, open)!;
    expect(notice.kind).toBe("notSent");
    expect(notice.title).toBe('compose.notSentMany {"count":2}');
    notice.acts![0]!.onPress();
    expect(opened).toEqual([["e:re:m1", "e:re:m2"]]);
  });

  it("a letter queued says it has not gone yet, with Open; one on its way says to whom, with no act; nothing on the line says nothing", () => {
    const queued = sendingNotice(t, [item("queued")], open)!;
    expect(queued.kind).toBe("sending");
    expect(queued.line).toMatch(/^reply\.statusQueued/);
    expect(queued.acts?.length).toBe(1);
    const sending = sendingNotice(t, [item("sending")], open)!;
    expect(sending.title).toBe('sendingLine.sending {"name":"Lena"}');
    expect(sending.acts).toBeUndefined();
    expect(sendingNotice(t, [], open)).toBeNull();
  });

  it("what could not be saved is counted before what has not gone through yet", () => {
    expect(unsavedTitle(t, 2, 3)).toBe('sync.unsavedCount {"count":2}');
    expect(unsavedTitle(t, 0, 3)).toBe('sync.unsavedPendingCount {"count":3}');
    expect(unsavedTitle(t, 0, 0)).toBeNull();
  });
});
