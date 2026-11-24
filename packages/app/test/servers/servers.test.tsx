/** @vitest-environment jsdom */
/**
 * THE PHONE'S LIST OF SERVERS OVER A FAKE DOOR (the ruling's section 6, "Servers"): a press on a row sends `switch`, or
 * goes to the scan where its pairing ended; a pairing's Forget names that row and no other; Stop and remove asks
 * first by what `forget.ask` answered and removes nothing until the dialog's verb, and after a removal that kept the
 * store Keep the mailbox opens it again; Sync now and Disconnect stand only while a session is live; what a forget
 * left stands though its row is gone; Back is the door's way out, and the first screen where nothing can be opened.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider, fillOver, type Messages } from "../../src/text/index.js";
import { ServersPage } from "../../src/servers/index.js";
import phoneDe from "../../messages/phone.de.json" with { type: "json" };
import phone from "../../messages/phone.en.json" with { type: "json" };
import { COMPUTER, fakeServersDoor, HOSTED, OWN } from "../support/servers.js";

const S = phone.servers;
const R: Record<string, string> = phone.phoneRefusal;
const settle = (): Promise<void> => act(async () => {});
const press = (name: string, within_: HTMLElement = document.body): void =>
  void fireEvent.click(within(within_).getByRole("button", { name: (n) => n.replace(/\s*↵$/, "") === name }));
const says = (s: string): boolean => (document.body.textContent ?? "").includes(s.replace(/\.$/, ""));
/** The sheet under a heading: its title's header, and the sheet that holds it. */
const sheetOf = (title: string): HTMLElement =>
  screen.getByRole("heading", { name: title }).parentElement!.parentElement!;
/** A row of the Paired sheet, by the name it is drawn under (a way to add one may carry the same name). */
const row = (name: string, paired: string = S.paired): HTMLElement =>
  within(sheetOf(paired)).getByRole("group", { name });
const noRow = (name: string): boolean => within(sheetOf(S.paired)).queryByRole("group", { name }) === null;
/** Native's `state` event, as the page takes it. */
const tell = (
  fake: ReturnType<typeof fakeServersDoor>,
  next: Parameters<ReturnType<typeof fakeServersDoor>["tell"]>[0],
): void => act(() => fake.tell(next));
/** The hardware back, as native asks the page: whether it took it. */
const hardwareBack = (fake: ReturnType<typeof fakeServersDoor>): boolean => {
  let took = false;
  act(() => {
    took = fake.back();
  });
  return took;
};

function draw(fake: ReturnType<typeof fakeServersDoor>, lang: "en" | "de" = "en") {
  const messages =
    lang === "de" ? fillOver(phone as unknown as Messages, phoneDe as unknown as Messages) : phone;
  return render(
    <TextProvider locale={lang} messages={messages as never} timeZone="UTC">
      <ServersPage door={fake.door} />
    </TextProvider>,
  );
}

const live = (paired = [HOSTED, COMPUTER], openId = HOSTED.id) => ({
  session: "live" as const,
  openId,
  paired,
});

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

describe("the rows", () => {
  it("draw the open session, then each row; a press opens a row, or pairs it again where its pairing ended", async () => {
    const ended = { ...COMPUTER, needsPair: true, account: null };
    const fake = fakeServersDoor({ state: live([HOSTED, ended]), answers: { switch: () => ({ ok: true }) } });
    draw(fake);
    expect(within(sheetOf(S.ways.cloud.name)).getByText(S.connected)).toBeTruthy();
    expect(within(row(S.ways.cloud.name)).getByText(S.openTag)).toBeTruthy();
    expect(within(row(COMPUTER.address)).queryByText(S.kind.computer)).toBeNull();
    expect(within(row(COMPUTER.address)).getByText(S.pairEnded)).toBeTruthy();
    fireEvent.click(within(row(S.ways.cloud.name)).getByText(HOSTED.account!));
    fireEvent.click(within(row(COMPUTER.address)).getByText(S.pairEnded));
    press(S.pairAgain, row(COMPUTER.address));
    await settle();
    expect(fake.asked).toEqual([
      { kind: "switch", ask: { id: HOSTED.id } },
      { kind: "waysIn", ask: "scan" },
      { kind: "waysIn", ask: "scan" },
    ]);
  });

  it("forget a pairing on its press, that row and no other: the phone keeps the other", async () => {
    const fake = fakeServersDoor({ state: live(), answers: { forget: () => ({ k: "gone", after: null }) } });
    draw(fake);
    press(S.forget, row(COMPUTER.address));
    await settle();
    expect(fake.asked).toEqual([{ kind: "forget", ask: { id: COMPUTER.id, anyway: false } }]);
    tell(fake, { paired: [HOSTED] });
    expect(noRow(COMPUTER.address)).toBe(true);
    expect(row(S.ways.cloud.name)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows opening and forgetting a pairing as separate controls", async () => {
    const fake = fakeServersDoor({ state: live(), answers: { switch: () => ({ ok: true }) } });
    draw(fake);
    const computer = row(COMPUTER.address);
    press(COMPUTER.address, computer);
    await settle();
    expect(fake.asked).toEqual([{ kind: "switch", ask: { id: COMPUTER.id } }]);
    expect(within(computer).getByRole("button", { name: S.forget })).toBeTruthy();
  });
});

describe("Stop and remove", () => {
  it("asks first by what forget.ask answered, and removes nothing until the dialog's verb, then exactly that mailbox", async () => {
    const fake = fakeServersDoor({
      state: live([OWN, COMPUTER], OWN.id),
      answers: {
        "forget.ask": () => ({ drafts: 2, settings: "answer" }),
        forget: () => ({ k: "gone", after: null }),
      },
    });
    draw(fake);
    press(S.stopAndRemove, row(S.ownName));
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(S.remove.title.replace(/\.$/, ""));
    expect(dialog.textContent).toContain(S.remove.settingsAnswer);
    expect(dialog.textContent).toContain("Removing it deletes the 2 unsent drafts on this phone.");
    expect(fake.kinds()).toEqual(["forget.ask"]);
    // The keys land on the safe answer.
    expect(document.activeElement?.textContent).toContain(S.remove.keep);
    press(S.remove.removeAnyway, dialog);
    await settle();
    expect(fake.asked).toEqual([
      { kind: "forget.ask", ask: { id: OWN.id } },
      { kind: "forget", ask: { id: OWN.id, anyway: true } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("removes at once where the store holds nothing no server has, and with drafts alone removes them, not anyway", async () => {
    const answers = [
      { drafts: 0, settings: "none" as const },
      { drafts: 1, settings: "none" as const },
    ];
    const fake = fakeServersDoor({
      state: live([OWN, COMPUTER], OWN.id),
      answers: {
        "forget.ask": () => answers.shift()!,
        forget: () => ({ k: "kept", said: { code: "forgetEngineRemains", args: [""] } }),
      },
    });
    draw(fake);
    press(S.stopAndRemove, row(S.ownName));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    press(S.stopAndRemove, row(S.ownName));
    await settle();
    press(S.remove.removeDrafts, screen.getByRole("dialog"));
    await settle();
    expect(fake.asked.filter((a) => a.kind === "forget")).toEqual([
      { kind: "forget", ask: { id: OWN.id, anyway: false } },
      { kind: "forget", ask: { id: OWN.id, anyway: false } },
    ]);
  });

  it("the dialog's way out removes nothing, and so do Escape and the hardware back", async () => {
    const fake = fakeServersDoor({
      state: live([OWN], OWN.id),
      answers: { "forget.ask": () => ({ drafts: null, settings: "none" }) },
    });
    draw(fake);
    for (const out of ["keep", "escape", "back"] as const) {
      press(S.stopAndRemove, row(S.ownName));
      await settle();
      expect(screen.getByRole("dialog").textContent).toContain(S.remove.draftsUnknown);
      if (out === "keep") press(S.remove.keep, screen.getByRole("dialog"));
      else if (out === "escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      else expect(hardwareBack(fake)).toBe(true);
      await settle();
      expect(screen.queryByRole("dialog"), out).toBeNull();
    }
    expect(fake.kinds()).toEqual(["forget.ask", "forget.ask", "forget.ask"]);
  });

  it("a forget.ask the bridge refused, or answered in no shape it can read, asks first as a count it cannot read", async () => {
    const answers: (() => unknown)[] = [
      () => {
        throw new Error("deadline");
      },
      () => ({ drafts: "2", settings: "later" }),
    ];
    const fake = fakeServersDoor({
      state: live([OWN], OWN.id),
      answers: { "forget.ask": () => answers.shift()!() as never },
    });
    draw(fake);
    for (const _ of [0, 1]) {
      press(S.stopAndRemove, row(S.ownName));
      await settle();
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain(S.remove.draftsUnknown);
      expect(dialog.textContent).toContain(S.remove.settingsUnknown);
      press(S.remove.keep, dialog);
      await settle();
    }
    expect(fake.kinds()).toEqual(["forget.ask", "forget.ask"]);
  });

  it("a removal that kept the store asks about the settings; Keep the mailbox opens it again, Remove anyway removes it", async () => {
    const forgot = [
      { k: "asks" as const, settings: "unsaved" as const },
      { k: "asks" as const, settings: "newer" as const },
    ];
    const fake = fakeServersDoor({
      state: live([OWN], OWN.id),
      answers: {
        "forget.ask": () => ({ drafts: 0, settings: "none" }),
        forget: () => forgot.shift() ?? { k: "gone", after: null },
        switch: () => ({ ok: true }),
      },
    });
    draw(fake);
    press(S.stopAndRemove, row(S.ownName));
    await settle();
    expect(screen.getByRole("dialog").textContent).toContain(S.remove.settingsUnsaved);
    press(S.remove.keep, screen.getByRole("dialog"));
    await settle();
    press(S.stopAndRemove, row(S.ownName));
    await settle();
    expect(screen.getByRole("dialog").textContent).toContain(S.remove.settingsNewer);
    press(S.remove.removeAnyway, screen.getByRole("dialog"));
    await settle();
    expect(fake.asked).toEqual([
      { kind: "forget.ask", ask: { id: OWN.id } },
      { kind: "forget", ask: { id: OWN.id, anyway: false } },
      { kind: "switch", ask: { id: OWN.id } },
      { kind: "forget.ask", ask: { id: OWN.id } },
      { kind: "forget", ask: { id: OWN.id, anyway: false } },
      { kind: "forget", ask: { id: OWN.id, anyway: true } },
      // It was the last row, and nothing of it is left: the first screen.
      { kind: "waysIn", ask: "welcome" },
    ]);
  });
});

describe("what a forget left", () => {
  it("a refusal says its sentence and the rows stay as native tells them; what was left stands when its row is gone", async () => {
    const fake = fakeServersDoor({
      state: live(),
      answers: { forget: () => ({ k: "kept", said: { code: "forgetStillPending", args: [] } }) },
    });
    draw(fake);
    press(S.forget, row(COMPUTER.address));
    await settle();
    // Native holds what stands, and tells it: the page draws the state, not the answer.
    tell(fake, { after: { code: "forgetStillPending", args: [] } });
    expect(says(R.forgetStillPending!)).toBe(true);
    expect(row(COMPUTER.address)).toBeTruthy();
    tell(fake, { paired: [HOSTED], after: { code: "forgetServerUnreachable", args: [] } });
    expect(says(R.forgetServerUnreachable!)).toBe(true);
    expect(noRow(COMPUTER.address)).toBe(true);
    expect(fake.kinds()).toEqual(["forget"]);
  });

  it("the last pairing forgotten clean goes to the first screen; one that left something stands on the list", async () => {
    const forgot = [
      { k: "gone" as const, after: { code: "forgetServerOwed", args: [] } },
      { k: "gone" as const, after: null },
    ];
    const fake = fakeServersDoor({
      state: { paired: [COMPUTER] },
      answers: { forget: () => forgot.shift()! },
    });
    draw(fake);
    press(S.forget, row(COMPUTER.address));
    await settle();
    expect(fake.kinds()).toEqual(["forget"]);
    press(S.forget, row(COMPUTER.address));
    await settle();
    expect(fake.asked.at(-1)).toEqual({ kind: "waysIn", ask: "welcome" });
  });

  it("keeps Servers open when another pairing appears while Forget is pending", async () => {
    let finish!: () => void;
    const response = new Promise<{ k: "gone"; after: null }>((resolve) => {
      finish = () => resolve({ k: "gone", after: null });
    });
    const fake = fakeServersDoor({ state: { paired: [COMPUTER] }, answers: { forget: () => response } });
    draw(fake);
    press(S.forget, row(COMPUTER.address));
    tell(fake, { paired: [HOSTED] });
    await act(async () => finish());
    expect(fake.asked).toEqual([{ kind: "forget", ask: { id: COMPUTER.id, anyway: false } }]);
    expect(row(S.ways.cloud.name)).toBeTruthy();
  });
});

describe("the session", () => {
  it("has Sync now and Disconnect only while live: none in refused, ended, none and opening", () => {
    const fake = fakeServersDoor({ state: live() });
    draw(fake);
    press(S.syncNow);
    press(S.disconnect);
    expect(fake.kinds()).toEqual(["sync", "disconnect"]);
    for (const session of ["refused", "ended", "none", "opening"] as const) {
      tell(fake, {
        session,
        openId: null,
        said: session === "refused" || session === "ended" ? { code: "pairEnded", args: [] } : null,
      });
      expect(screen.queryByRole("button", { name: S.syncNow }), session).toBeNull();
      expect(screen.queryByRole("button", { name: S.disconnect }), session).toBeNull();
    }
  });

  it("says a sync that did not go through: a changed key, a certificate, or what native said; and Pair again where the pairing ended", async () => {
    const fake = fakeServersDoor({ state: { ...live(), syncStopped: "keyChanged" } });
    draw(fake);
    expect(says(`${S.syncStopped} ${R.pinChanged}`)).toBe(true);
    tell(fake, { syncStopped: "certificate" });
    expect(says(`${S.syncStopped} ${S.certificateRefused}`)).toBe(true);
    tell(fake, {
      syncStopped: null,
      syncSaid: { code: "verbatimDetail", args: ["The server did not answer in time."] },
    });
    expect(says(`${S.syncFailed} The server did not answer in time.`)).toBe(true);
    tell(fake, { session: "ended", openId: null, said: { code: "pairEnded", args: [] }, syncSaid: null });
    expect(says(R.pairEnded!)).toBe(true);
    // No row's pairing ended here: the one Pair again is the refusal's.
    press(S.pairAgain);
    expect(fake.asked).toEqual([{ kind: "waysIn", ask: "scan" }]);
  });

  it("says no pairings yet only where nothing else is said", () => {
    const fake = fakeServersDoor();
    draw(fake);
    expect(says(S.empty)).toBe(true);
    tell(fake, { session: "refused", said: { code: "admitNoPin", args: [] } });
    expect(says(S.empty)).toBe(false);
    tell(fake, { session: "none", said: null, after: { code: "forgetClaimStands", args: ["4"] } });
    expect(says(S.empty)).toBe(false);
  });
});

describe("the ways out and the ways in", () => {
  it("Back is native's way out over an open mailbox or where a row can be opened again, else the first screen", () => {
    const fake = fakeServersDoor({ state: live() });
    draw(fake);
    press(S.back);
    expect(hardwareBack(fake)).toBe(true);
    tell(fake, { session: "none", openId: null, paired: [{ ...COMPUTER, needsPair: true, account: null }] });
    press(S.back);
    tell(fake, { paired: [] });
    expect(hardwareBack(fake)).toBe(true);
    tell(fake, { paired: [OWN] });
    press(S.back);
    expect(fake.asked).toEqual([
      { kind: "leave", ask: {} },
      { kind: "leave", ask: {} },
      { kind: "waysIn", ask: "welcome" },
      { kind: "waysIn", ask: "welcome" },
      { kind: "leave", ask: {} },
    ]);
  });

  it("each way opens the ways in at its step; the mailbox on this phone only where this build offers it, never in the calendar app", () => {
    const fake = fakeServersDoor();
    draw(fake);
    for (const way of ["cloud", "server", "computer", "standalone"] as const)
      fireEvent.click(screen.getByText(S.ways[way].name));
    expect(fake.asked.map((a) => a.ask)).toEqual(["scan", "server", "computer", "terms"]);
    expect(says(S.ways.computer.line.android)).toBe(true);
    cleanup();
    for (const config of [
      { organizes: "withheld" as const },
      { app: "ohcal" as const },
      { organizes: "maybe" as never },
    ]) {
      draw(fakeServersDoor({ config }));
      expect(screen.queryByText(S.ways.standalone.name), JSON.stringify(config)).toBeNull();
      expect(screen.getByText(S.ways.server.name)).toBeTruthy();
      cleanup();
    }
    draw(fakeServersDoor({ config: { os: "ios" } }));
    expect(says(S.ways.computer.line.ios)).toBe(true);
    expect(says(S.ways.standalone.line.ios)).toBe(true);
  });

  it("says the list and its removal in German", async () => {
    const fake = fakeServersDoor({
      state: live([OWN], OWN.id),
      answers: { "forget.ask": () => ({ drafts: 1, settings: "newer" }) },
    });
    draw(fake, "de");
    expect(says(phoneDe.servers.ownName)).toBe(true);
    press(phoneDe.servers.stopAndRemove, row(phoneDe.servers.ownName, phoneDe.servers.paired));
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(phoneDe.servers.remove.settingsNewer);
    expect(dialog.textContent).toContain(
      "Beim Entfernen wird der nicht gesendete Entwurf auf diesem Handy gelöscht.",
    );
    expect(within(dialog).getByRole("button", { name: phoneDe.servers.remove.removeAnyway })).toBeTruthy();
  });
});
