/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WallPage, wallStateOf, type WallDoor, type WallState } from "../../src/doors/wall/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };
import { drawIn, stop } from "./desktop-support.js";

/**
 * THE WALL, over a fake door: the headline says why and since when; under it that the mailbox is untouched and when
 * what ohmail keeps is erased; every way out is the door's, each with the line that says what it does; while the
 * service is asked again only Sign out stands; it draws no mail and no list of it. The same page ends an account
 * erased elsewhere.
 */
const W = en.accessLock;
const refused = (o: Partial<Extract<WallState, { at: "refused" }>> = {}): WallState => ({
  at: "refused",
  headline: { key: "trialEnded", date: "18 Nov 2026" },
  standing: { kind: "stopped", erasure: { kind: "dated", date: "18 Dec 2026" } },
  check: "idle",
  wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: null },
  moveOut: { exporting: false, failed: false },
  deleteHint: "deleteHint",
  signingOut: false,
  signOutSaid: null,
  ...o,
});

function draw(state: WallState, words: Record<string, unknown> = en, locale: "en" | "de" = "en") {
  const door: WallDoor = {
    state,
    wayBack: vi.fn(),
    checkAgain: vi.fn(),
    moveOut: vi.fn(),
    guide: vi.fn(),
    deleteNow: vi.fn(),
    signOut: vi.fn(),
    changePassword: vi.fn(),
    home: vi.fn(),
  };
  const view = drawIn(<WallPage door={door} />, words, locale);
  return { view, door };
}
const page = () => document.body.textContent ?? "";
const press = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
/** A way out is one press, named by its name and the line under it. */
const way = (label: string) =>
  screen.getByRole("button", {
    name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  }) as HTMLButtonElement;
/** The page's sentence, which is its line as the design draws it, not a heading. */
const sentence = (): string => document.querySelector("main p")?.textContent ?? "";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the wall says what happened, and that the mailbox is untouched", () => {
  it("the headline says why and since when; the erasure's date; nothing of mail", () => {
    const { door } = draw(refused());
    expect(sentence()).toBe(stop(W.trialEnded.replace("{date}", "18 Nov 2026")));
    expect(screen.queryByRole("heading")).toBeNull();
    for (const said of [W.stoppedUntouched, W.erasure.replace("{date}", "18 Dec 2026")])
      expect(page()).toContain(said);
    for (const role of ["option", "listbox", "row", "grid", "article"])
      expect(screen.queryAllByRole(role), role).toEqual([]);
    expect(wallStateOf(door.state)).toBe("trial");
  });

  it.each([
    [{ key: "canceled", date: "1 Oct" } as const, W.canceled.replace("{date}", "1 Oct"), "canceled"],
    [{ key: "unpaid", date: "1 Oct" } as const, W.unpaid.replace("{date}", "1 Oct"), "unpaid"],
    [{ key: "suspendedTitle" } as const, W.suspendedTitle, "suspended"],
    [{ key: "title" } as const, W.title, "plain"],
  ])("headline %j", (headline, said, id) => {
    const { door } = draw(refused({ headline }));
    expect(sentence()).toBe(stop(said));
    expect(wallStateOf(door.state)).toBe(id);
  });

  it("an operator hold, an unknown date, and an older server each say only what is true", () => {
    draw(refused({ standing: { kind: "stopped", erasure: { kind: "held" } } }));
    expect(page()).toContain(W.erasureHeld);
    cleanup();
    const unknown = draw(
      refused({
        standing: { kind: "stopped", erasure: { kind: "unknown" } },
        deleteHint: "deleteHintUndated",
      }),
    );
    expect(page()).toContain(W.erasureUnknown);
    expect(page()).toContain(W.deleteHintUndated);
    expect(wallStateOf(unknown.door.state)).toBe("undated");
    cleanup();
    draw(refused({ standing: { kind: "kept" }, headline: { key: "title" } }));
    expect(page()).toContain(W.keptLine);
    expect(page()).toContain(W.keptNote);
    expect(page()).not.toContain(W.stoppedUntouched);
  });

  it("an account that never started: the trial is the page", () => {
    const { door } = draw(
      refused({
        headline: { key: "neverStartedTitle" },
        standing: { kind: "fresh" },
        wayBack: { label: "startTrial", hint: "startTrialHint", minting: false, refusal: null },
        moveOut: null,
        deleteHint: "deleteHintNeverStarted",
      }),
    );
    expect(page()).toContain(W.neverLine);
    expect(page()).toContain(W.neverNote);
    expect(press(W.startTrial)).toBeTruthy();
    expect(page()).toContain(W.deleteHintNeverStarted);
    expect(screen.queryByRole("button", { name: new RegExp(`^${W.moveOut}`) })).toBeNull();
    expect(wallStateOf(door.state)).toBe("never");
  });
});

describe("every way out is the door's, with the line that says what it does", () => {
  it("the way back, the settings file, the guide, deleting now, Sign out, the password", () => {
    const { door } = draw(refused());
    /* The way back is the ink button; each way out says what it does, deleting now with the date it comes before. */
    expect(page()).toContain(W.moveOutLine);
    expect(page()).toContain(W.deleteHintOn.replace("{date}", "18 Dec 2026"));
    fireEvent.click(press(W.subscribe));
    fireEvent.click(way(W.moveOut));
    fireEvent.click(press(W.moveOutGuide));
    fireEvent.click(way(W.deleteNow));
    fireEvent.click(press(W.signOut));
    fireEvent.click(press(W.changePassword));
    for (const act of ["wayBack", "moveOut", "guide", "deleteNow", "signOut", "changePassword"] as const)
      expect(door[act], act).toHaveBeenCalledTimes(1);
  });

  it("no account page here: no way back; no file here: no file", () => {
    draw(refused({ wayBack: null, moveOut: null }));
    expect(screen.queryByRole("button", { name: W.subscribe })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(`^${W.moveOut}`) })).toBeNull();
    expect(screen.queryByRole("button", { name: W.moveOutGuide })).toBeNull();
    expect(way(W.deleteNow)).toBeTruthy();
  });

  it("the way back's own words: an operator hold opens the account, a server with no lifecycle manages it", () => {
    draw(refused({ wayBack: { label: "openAccount", hint: null, minting: false, refusal: null } }));
    expect(press(W.openAccount)).toBeTruthy();
    cleanup();
    draw(refused({ wayBack: { label: "manage", hint: null, minting: false, refusal: null } }));
    expect(press(W.manage)).toBeTruthy();
  });

  it("a press in flight is off; each refusal is said", () => {
    const { door } = draw(
      refused({
        wayBack: { label: "subscribe", hint: "subscribeHint", minting: true, refusal: "mintUnverified" },
      }),
    );
    expect(press(W.subscribe).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(W.unverifiedEmail);
    expect(wallStateOf(door.state)).toBe("unverified");
    cleanup();
    const nolink = draw(
      refused({
        wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: "mintFailed" },
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain(W.mintFailed);
    expect(wallStateOf(nolink.door.state)).toBe("nolink");
    cleanup();
    const nofile = draw(refused({ moveOut: { exporting: false, failed: true } }));
    expect(screen.getByRole("alert").textContent).toContain(W.moveOutFailed);
    expect(wallStateOf(nofile.door.state)).toBe("nofile");
    cleanup();
    draw(refused({ signingOut: true, signOutSaid: "The session could not be ended." }));
    expect(press(W.signOut).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("The session could not be ended.");
  });

  it("back from paying, not confirmed yet: said, and Check again is the door's", () => {
    const { door } = draw(refused({ check: "pending" }));
    expect(page()).toContain(W.pendingLine);
    expect(page()).toContain(W.pendingNote);
    fireEvent.click(press(W.checkAgain));
    expect(door.checkAgain).toHaveBeenCalledTimes(1);
    expect(wallStateOf(door.state)).toBe("pending");
  });

  it("while the service is asked again only Sign out stands", () => {
    const { door } = draw(refused({ check: "checking" }));
    /* Shown as the line's tag, and said to a screen reader as it is asked, as the shipped wall did. */
    expect(screen.getByRole("status").textContent).toBe(W.checkingTag);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([W.signOut]);
    expect(wallStateOf(door.state)).toBe("checking");
  });
});

describe("an account erased from another browser", () => {
  it("says so, the mailbox untouched, and the way on is the door's", () => {
    const { door } = draw({ at: "erased", blocked: false });
    expect(sentence()).toBe(stop(W.erasedTitle));
    expect(page()).toContain(W.erasedUntouched);
    expect(page()).toContain(W.erasedGone);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(press(W.erasedHome));
    expect(door.home).toHaveBeenCalledTimes(1);
    expect(wallStateOf(door.state)).toBe("erased");
  });

  it("another tab holds the copy: said", () => {
    const { door } = draw({ at: "erased", blocked: true });
    expect(screen.getByRole("alert").textContent).toContain(W.erasedBlocked);
    expect(wallStateOf(door.state)).toBe("erasedtab");
  });
});

describe("its words", () => {
  it("waits without a word, and offers nothing to press, until they have arrived", () => {
    const { accessLock: _gone, ...without } = en;
    draw(refused(), without);
    expect(page()).toBe("");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("speaks German where the catalogue is German", () => {
    draw(refused(), de, "de");
    expect(way(de.accessLock.deleteNow)).toBeTruthy();
    expect(page()).toContain(de.accessLock.stoppedUntouched);
  });
});
