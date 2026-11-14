/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../../src/host/index.js";
import type { Answered } from "@ohmail/app-logic/mailboxes/connect/types";
import type { MailboxErased, OrganizeAnswer } from "@ohmail/app-logic/mailboxes/pane/types";
import type { FactorAsk, FactorSlot } from "../../../src/mailboxes/connect/contract.js";
import { later } from "../connect/support.js";
import { A, B, D, M, NOW, WINDOW_CLOSED, drawPane, factorButtons, fakePane, ok, row } from "./support.js";

/** A dialog stand-in that counts the times it was put on screen: a second ask is a second mount. */
function counted(seen: { asks: FactorAsk[]; shown: number }): FactorSlot {
  const buttons = factorButtons(seen);
  function Shown({ ask }: { ask: FactorAsk }) {
    useEffect(() => {
      seen.shown += 1;
    }, []);
    return <>{buttons(ask)}</>;
  }
  return (ask) => <Shown ask={ask} />;
}

/**
 * THE ONE STEP-UP DIALOG, FOR THE PANE'S GATED VERBS. Remove, erase and take over are tried first; only the server's
 * refusal parks the press, as a value, and asks the factor once. Verified, the same press is sent once more; Cancel
 * sends nothing; a second refusal after the factor says to sign in again. No act fires on a default.
 */
const settle = (): Promise<void> => act(async () => {});
const press = (name: string, n = 0): void =>
  void fireEvent.click(screen.getAllByRole("button", { name })[n]!);
const open = (address: string): void =>
  void fireEvent.click(screen.getByRole("button", { name: new RegExp(address.replace(".", "\\.")) }));
const dialog = () => screen.queryByRole("dialog", { name: "the second factor" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function removing(script: Parameters<typeof fakePane>[0]) {
  const seen = { asks: [] as FactorAsk[], shown: 0 };
  const pane = fakePane({
    list: [ok([row("mbx-a", A), row("mbx-b", B)])],
    allowance: [ok({ emailVerified: true, access: null })],
    ...script,
  });
  const view = drawPane(pane.wire, { factor: counted(seen) });
  await settle();
  open(A);
  press(M.remove);
  return { pane, seen, view };
}

describe("remove, behind the one dialog", () => {
  it("opens its confirmation and sends nothing until the confirm is pressed", async () => {
    const { pane } = await removing({});
    expect(screen.getByRole("heading", { name: M.removeTitle.replace("{address}", A) })).toBeTruthy();
    expect(pane.writes()).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it("is tried first: an open window removes with no dialog at all", async () => {
    const { pane, view } = await removing({
      remove: [ok(null)],
      list: [ok([row("mbx-a", A), row("mbx-b", B)]), ok([row("mbx-b", B)])],
    });
    press(M.removeConfirm);
    await settle();
    expect(pane.of("remove").map((c) => c.args)).toEqual([["mbx-a"]]);
    expect(dialog()).toBeNull();
    expect(view.drained).toEqual(["refresh", "sync"]);
  });

  it("a closed window asks the factor once; verified, the same press is sent once more", async () => {
    const { pane, seen } = await removing({ remove: [WINDOW_CLOSED, ok(null)] });
    press(M.removeConfirm);
    await settle();
    expect(pane.of("remove")).toHaveLength(1);
    expect(seen.shown).toBe(1);
    expect(within(dialog()!).getByText(M.factorBodyRemove)).toBeTruthy();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "verify" }));
    await settle();
    expect(pane.of("remove").map((c) => c.args)).toEqual([["mbx-a"], ["mbx-a"]]);
    expect(dialog()).toBeNull();
  });

  it("refused again right after the factor: says sign in again, and asks no second time", async () => {
    const { pane, seen } = await removing({ remove: [WINDOW_CLOSED, WINDOW_CLOSED] });
    press(M.removeConfirm);
    await settle();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "verify" }));
    await settle();
    expect(pane.of("remove")).toHaveLength(2);
    expect(dialog()).toBeNull();
    expect(seen.shown).toBe(1);
    expect(screen.getByText(D.stepUpExpired)).toBeTruthy();
  });

  it("Cancel sends nothing more, and a factor that lands after it says nothing ran", async () => {
    const { pane, seen } = await removing({ remove: [WINDOW_CLOSED, ok(null)] });
    press(M.removeConfirm);
    await settle();
    const ask = seen.asks[0]!;
    fireEvent.click(within(dialog()!).getByRole("button", { name: "cancel" }));
    await settle();
    expect(dialog()).toBeNull();
    act(() => ask.onVerified());
    act(() => ask.onDiscarded());
    await settle();
    expect(pane.of("remove")).toHaveLength(1);
    expect(screen.getByText(M.cancelledNothingChanged)).toBeTruthy();
  });

  it("with no dialog to ask, a closed window says sign in again and parks nothing", async () => {
    const pane = fakePane({
      list: [ok([row("mbx-a", A)])],
      allowance: [ok({ emailVerified: true, access: null })],
      remove: [WINDOW_CLOSED],
    });
    drawPane(pane.wire, { factor: NONE });
    await settle();
    open(A);
    press(M.remove);
    press(M.removeConfirm);
    await settle();
    expect(pane.of("remove")).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(screen.getByText(D.stepUpExpired)).toBeTruthy();
  });
});

describe("erase, behind the same dialog", () => {
  it("sends the address as it was typed, never filled in, and the same body again after the factor", async () => {
    const { pane } = await removing({
      erase: [
        WINDOW_CLOSED,
        ok({ erasing: false, mailboxId: row("mbx-a", A).id, messages: 3, drafts: 1, draftsUnanchored: 0 }),
      ],
    });
    fireEvent.click(screen.getByRole("radio", { name: M.removeEraseChoice }));
    const confirm = () => screen.getByRole("button", { name: M.removeEraseConfirm }) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(M.removeEraseTypeLabel), { target: { value: ` ${A}` } });
    fireEvent.click(confirm());
    await settle();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "verify" }));
    await settle();
    expect(pane.of("erase").map((c) => c.args)).toEqual([
      ["mbx-a", ` ${A}`],
      ["mbx-a", ` ${A}`],
    ]);
    expect(pane.of("remove")).toEqual([]);
  });

  it("typing while the factor is asked withdraws the waiting press: a factor verified after it sends nothing", async () => {
    const { pane, seen } = await removing({
      erase: [
        WINDOW_CLOSED,
        ok({ erasing: false, mailboxId: row("mbx-a", A).id, messages: 3, drafts: 1, draftsUnanchored: 0 }),
      ],
    });
    fireEvent.click(screen.getByRole("radio", { name: M.removeEraseChoice }));
    fireEvent.change(screen.getByLabelText(M.removeEraseTypeLabel), { target: { value: A } });
    press(M.removeEraseConfirm);
    await settle();
    const ask = seen.asks[0]!;
    fireEvent.change(screen.getByLabelText(M.removeEraseTypeLabel), { target: { value: `${A}x` } });
    expect(dialog()).toBeNull();
    act(() => ask.onVerified());
    await settle();
    expect(pane.of("erase")).toHaveLength(1);
  });

  it("the choice changed while the erase is on its way: no factor is asked for the press it was moved under, and nothing ran", async () => {
    const answer = later<Answered<MailboxErased>>();
    const { pane } = await removing({ erase: [answer.promise], remove: [ok(null)] });
    fireEvent.click(screen.getByRole("radio", { name: M.removeEraseChoice }));
    fireEvent.change(screen.getByLabelText(M.removeEraseTypeLabel), { target: { value: A } });
    press(M.removeEraseConfirm);
    await settle();
    expect(pane.of("erase")).toHaveLength(1);
    // The person takes the erasure back while the press is still on its way: ohmail's copy is to stay.
    fireEvent.click(screen.getByRole("radio", { name: M.removeKeepChoice }));
    await act(async () => answer.resolve(WINDOW_CLOSED));
    await settle();
    const asked = dialog() !== null;
    if (asked) {
      fireEvent.click(within(dialog()!).getByRole("button", { name: "verify" }));
      await settle();
    }
    expect({ asked, erases: pane.of("erase").length }).toEqual({ asked: false, erases: 1 });
    expect(screen.getByText(M.cancelledNothingChanged)).toBeTruthy();
    // The next press tries the confirmation as it stands: a removal that keeps the copy.
    press(M.removeConfirm);
    await settle();
    expect(pane.writes().map((c) => c.verb)).toEqual(["erase", "remove"]);
  });

  it("a mistyped address is refused by the server and said at the confirmation, with the typing kept", async () => {
    const mismatch = {
      ok: false as const,
      refusal: {
        status: 409,
        code: "erase_not_confirmed",
        message: "no",
        details: {
          reason: null,
          transport: null,
          tls: null,
          authHint: null,
          localServer: false,
          field: null,
          why: null,
          write: null,
          provider: null,
          mailboxLimit: null,
          mailboxCount: null,
        },
      },
    };
    await removing({ erase: [mismatch] });
    fireEvent.click(screen.getByRole("radio", { name: M.removeEraseChoice }));
    fireEvent.change(screen.getByLabelText(M.removeEraseTypeLabel), {
      target: { value: "someone@else.example" },
    });
    press(M.removeEraseConfirm);
    await settle();
    expect(screen.getByText(M.removeEraseMismatch)).toBeTruthy();
    expect((screen.getByLabelText(M.removeEraseTypeLabel) as HTMLInputElement).value).toBe(
      "someone@else.example",
    );
  });
});

describe("take over, behind the same dialog", () => {
  it("a released mailbox's one press is tried first, parked on a closed window, and sent once after the factor", async () => {
    const seen = { asks: [] as FactorAsk[], shown: 0 };
    const released = row("mbx-a", A, {
      organizerRole: "reader",
      organizerReleasedAt: "2026-11-10T08:00:00.000Z",
      organizedBy: null,
      organizerState: null,
    });
    const pane = fakePane({
      list: [ok([released])],
      allowance: [ok({ emailVerified: true, access: null })],
      organizeHere: [WINDOW_CLOSED, ok({ outcome: "authorized" })],
    });
    drawPane(pane.wire, { factor: counted(seen) });
    await settle();
    press(M.organizeHere);
    await settle();
    expect(pane.of("organizeHere")).toHaveLength(1);
    expect(within(dialog()!).getByText(M.factorBodyTakeover)).toBeTruthy();
    fireEvent.click(within(dialog()!).getByRole("button", { name: "verify" }));
    await settle();
    expect(pane.of("organizeHere").map((c) => c.args)).toEqual([
      ["mbx-a", {}],
      ["mbx-a", {}],
    ]);
  });

  it("a take-over under way says that it is working and takes no second press; once taken, its press is off", async () => {
    const answer = later<Answered<OrganizeAnswer>>();
    const released = row("mbx-a", A, {
      organizerRole: "reader",
      organizerReleasedAt: "2026-11-10T08:00:00.000Z",
      organizedBy: null,
      organizerState: null,
    });
    const pane = fakePane({
      list: [ok([released])],
      allowance: [ok({ emailVerified: true, access: null })],
      organizeHere: [answer.promise],
    });
    drawPane(pane.wire, { factor: NONE });
    await settle();
    press(M.organizeHere);
    await settle();
    const working = screen.getByRole("button", { name: M.working });
    expect(working.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(working);
    expect(pane.of("organizeHere")).toHaveLength(1);
    await act(async () => answer.resolve(ok({ outcome: "authorized" })));
    await settle();
    expect(screen.getByRole("button", { name: M.organizeHere })).toHaveProperty("disabled", true);
    expect(pane.of("organizeHere")).toHaveLength(1);
  });

  it("the re-sync is never behind the dialog", async () => {
    const seen = { asks: [] as FactorAsk[], shown: 0 };
    const pane = fakePane({
      list: [ok([row("mbx-a", A)])],
      allowance: [ok({ emailVerified: true, access: null })],
      resync: [WINDOW_CLOSED],
    });
    drawPane(pane.wire, { factor: counted(seen) });
    await settle();
    open(A);
    press(M.syncNow);
    await settle();
    expect(seen.shown).toBe(0);
    expect(dialog()).toBeNull();
  });
});
