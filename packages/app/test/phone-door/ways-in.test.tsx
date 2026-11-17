/** @vitest-environment jsdom */
/**
 * THE PHONE'S WAYS IN OVER A FAKE DOOR (the ruling's section 6, "Ways in"): each press sends its one kind; Confirm
 * draws what native measured and never a field of the link; every way out of Confirm but the press gives the ticket
 * back, once, and so does a step left before its offer answered; a press reads as accepted only on `ok: true`; a
 * pasted link goes as the token beside the address as it stands; the mailbox way is absent where this build
 * withholds it and in the calendar app; the one form is mounted for the purpose `standalone` and its "connected"
 * opens the copy; a store's upgrade is said with its count and a second line after a while; a request the bridge
 * refused says the unknown sentence, never the bridge's word.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "../../src/text/index.js";
import { PhoneDoorPage, type WayInSeed } from "../../src/phone-door/index.js";
import phone from "../../messages/phone.en.json" with { type: "json" };
import { fakePhoneDoor } from "../support/phone-door.js";

const W = phone.phoneDoor;
const R: Record<string, string> = phone.phoneRefusal;
/** A sentence as the page's Said draws it: its closing full stop is the dot. */
const said = (s: string): string => s.replace(/\.$/, "");
/** Whether the page says a sentence now: a sentence is drawn in parts (its last word stays with the dot). */
const says = (s: string): boolean => (document.body.textContent ?? "").includes(said(s));
const settle = (): Promise<void> => act(async () => {});
/** A press by the button's name; a button that carries its key's hint ("↵") is named by its words. */
const press = (name: string): void =>
  void fireEvent.click(screen.getByRole("button", { name: (n) => n.replace(/\s*↵$/, "") === name }));
const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** A pairing link as a person pastes it: made up, no server knows it. */
const PASTED = "ohmail://pair?made-up-link";
const OFFER = {
  k: "offers" as const,
  ticket: "a".repeat(32),
  facts: { what: "computer" as const, address: "https://192.168.1.24:47800", key: "7F3A91C25D0E" },
};

function draw(fake: ReturnType<typeof fakePhoneDoor>, from?: WayInSeed) {
  return render(
    <TextProvider locale="en" messages={phone as never} timeZone="UTC">
      <PhoneDoorPage door={fake.door} from={from} />
    </TextProvider>,
  );
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
  vi.useRealTimers();
});

describe("the first screen", () => {
  it("offers the mailbox, the scan and the list of servers, each sending its one step", async () => {
    const fake = fakePhoneDoor();
    draw(fake);
    expect(says(W.welcome.line.ohmail)).toBe(true);
    press(W.welcome.servers);
    expect(fake.asked).toEqual([{ kind: "go", ask: "servers" }]);
    press(W.welcome.connect);
    expect(says(W.terms.say)).toBe(true);
  });

  it("draws no mailbox way where this build withholds it, or where native's word is anything else", () => {
    for (const organizes of ["withheld", "maybe"] as const) {
      draw(fakePhoneDoor({ config: { organizes: organizes as "withheld" } }));
      expect(screen.queryByRole("button", { name: (n) => n.startsWith(W.welcome.connect) })).toBeNull();
      expect(screen.getByRole("button", { name: (n) => n.startsWith(W.welcome.scan) })).toBeTruthy();
      cleanup();
    }
  });

  it("says the calendar app's line and never offers it a mailbox", () => {
    draw(fakePhoneDoor({ config: { app: "ohcal" } }));
    expect(says(W.welcome.line.ohcal)).toBe(true);
    expect(says(W.welcome.line.ohmail)).toBe(false);
    expect(screen.queryByRole("button", { name: (n) => n.startsWith(W.welcome.connect) })).toBeNull();
  });

  it("rings its doorbell by itself a moment after it arrived, and leaves no timer behind when it is left", () => {
    vi.useFakeTimers();
    draw(fakePhoneDoor());
    const stop = screen.getByRole("button", { name: W.welcome.ring });
    expect(stop.hasAttribute("data-ringing")).toBe(false);
    act(() => void vi.advanceTimersByTime(1100));
    expect(stop.hasAttribute("data-ringing")).toBe(true);
    cleanup();
    draw(fakePhoneDoor());
    press(W.welcome.connect);
    expect(says(W.terms.say)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a server by its address", () => {
  it("asks what answers there once, then offers its code and its token", async () => {
    const fake = fakePhoneDoor({
      answers: {
        "server.ask": () => ({
          k: "reached",
          address: "oh.lichtgrat.example",
          flavor: "selfhost",
          apiUnder: null,
        }),
      },
    });
    draw(fake, { step: "server" });
    type(W.server.label, "oh.lichtgrat.example");
    press(W.server.continue);
    await settle();
    expect(fake.asked).toEqual([{ kind: "server.ask", ask: { address: "oh.lichtgrat.example" } }]);
    press(W.server.token);
    expect((screen.getByLabelText(W.hand.addressLabel) as HTMLInputElement).value).toBe(
      "oh.lichtgrat.example",
    );
  });

  it("says a refusal by its code, and a request the bridge refused as the unknown sentence", async () => {
    const fake = fakePhoneDoor({
      answers: { "server.ask": () => ({ k: "refused", said: { code: "baseCleartext", args: [] } }) },
    });
    draw(fake, { step: "server" });
    press(W.server.continue);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(R.baseCleartext);
    cleanup();
    const thrown = fakePhoneDoor({
      answers: {
        "server.ask": () => {
          throw new Error("unreachable");
        },
      },
    });
    draw(thrown, { step: "server" });
    press(W.server.continue);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(R.unknown);
  });
});

describe("the scan", () => {
  it("starts the camera at the square, asks for it where it is off, and puts it away when the step ends", async () => {
    const fake = fakePhoneDoor({
      answers: { "scan.start": () => ({ camera: "off" }), "camera.allow": () => ({ camera: "on" }) },
    });
    draw(fake, { step: "scan" });
    await settle();
    expect(fake.kinds()).toEqual(["scan.start"]);
    expect(screen.getByRole("img", { name: W.scan.cameraOff })).toBeTruthy();
    press(W.scan.allow);
    await settle();
    expect(fake.kinds()).toEqual(["scan.start", "camera.allow", "scan.start"]);
    press(W.scan.byHand);
    expect(fake.kinds().at(-1)).toBe("scan.stop");
  });

  it("goes to Confirm with what native measured, and says a frame that was no code", async () => {
    const fake = fakePhoneDoor();
    draw(fake, { step: "scan" });
    await settle();
    act(() => fake.scan({ k: "notACode" }));
    expect(screen.getByRole("alert").textContent).toBe(W.scan.notACode);
    act(() => fake.scan(OFFER));
    expect(screen.getByText(OFFER.facts.address)).toBeTruthy();
  });
});

describe("by hand", () => {
  it("sends a pasted link as the token beside the address as it stands, once, and goes to Confirm", async () => {
    const fake = fakePhoneDoor({ answers: { hand: () => OFFER } });
    draw(fake, { step: "hand" });
    type(W.hand.addressLabel, "oh.lichtgrat.example");
    type(W.hand.tokenLabel, PASTED);
    press(W.hand.pair);
    await settle();
    expect(fake.asked).toEqual([{ kind: "hand", ask: { address: "oh.lichtgrat.example", token: PASTED } }]);
    expect(says(W.confirm.say)).toBe(true);
  });

  it("marks the address on a refused address, and the code on every other refusal", async () => {
    const fake = fakePhoneDoor({
      answers: { hand: () => ({ k: "refused", said: { code: "pairBadAddress", args: [] } }) },
    });
    draw(fake, { step: "hand" });
    press(W.hand.pair);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(R.pairBadAddress);
    expect(screen.getByLabelText(W.hand.addressLabel).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText(W.hand.tokenLabel).getAttribute("aria-invalid")).toBeNull();
  });

  it.each(["baseAddressMissing", "baseNotAnAddress", "baseCleartext", "baseNeedsTheCode"])(
    "marks the address on the server's validation answer %s",
    async (code) => {
      const fake = fakePhoneDoor({ answers: { hand: () => ({ k: "refused", said: { code, args: [] } }) } });
      draw(fake, { step: "hand" });
      press(W.hand.pair);
      await settle();
      expect(screen.getByLabelText(W.hand.addressLabel).getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByLabelText(W.hand.tokenLabel).getAttribute("aria-invalid")).toBeNull();
    },
  );

  it("gives back a ticket that answers after its step was left, once, and goes nowhere with it", async () => {
    for (const way of ["token", "link"] as const) {
      let answer: (offer: typeof OFFER) => void = () => undefined;
      const fake = fakePhoneDoor({
        answers: {
          "server.ask": () => ({
            k: "reached",
            address: "oh.lichtgrat.example",
            flavor: "selfhost",
            apiUnder: null,
          }),
          hand: () => new Promise<typeof OFFER>((resolve) => void (answer = resolve)),
        },
      });
      const drawn = draw(fake, { step: way === "token" ? "server" : "scan" });
      await settle();
      if (way === "token") {
        type(W.server.label, "oh.lichtgrat.example");
        press(W.server.continue);
        await settle();
        press(W.server.token);
        type(W.hand.tokenLabel, "made-up-code");
        press(W.hand.pair);
      } else {
        press(W.scan.byHand);
        type(W.scan.linkLabel, PASTED);
        press(W.scan.pair);
      }
      await settle();
      press(W.back);
      // `hand` answers once its step is gone: native holds the ticket until the page gives it back.
      await act(async () => answer(OFFER));
      expect(says(W.confirm.say), way).toBe(false);
      drawn.unmount();
      expect(
        fake.asked.filter((a) => a.kind === "dismiss"),
        way,
      ).toEqual([{ kind: "dismiss", ask: { ticket: OFFER.ticket } }]);
    }
  });
});

describe("Confirm", () => {
  it("draws what native measured, and nothing of the link the person pasted", async () => {
    const fake = fakePhoneDoor({ answers: { hand: () => OFFER } });
    const { container } = draw(fake, { step: "hand" });
    type(W.hand.addressLabel, "typed.example");
    type(W.hand.tokenLabel, "https://link-host.example/pair#made-up-link-field");
    press(W.hand.pair);
    await settle();
    expect(screen.getByText(W.confirm.what.computer)).toBeTruthy();
    expect(screen.getByText(OFFER.facts.address)).toBeTruthy();
    expect(screen.getByText(OFFER.facts.key)).toBeTruthy();
    for (const never of ["typed.example", "link-host.example", "made-up-link-field", OFFER.ticket])
      expect(container.innerHTML).not.toContain(never);
  });

  it("says that there is no key to compare where native measured none", () => {
    draw(fakePhoneDoor(), {
      step: "confirm",
      offer: { ticket: OFFER.ticket, facts: { ...OFFER.facts, what: "server", key: null } },
    });
    expect(screen.getByText(W.confirm.noKeyFine)).toBeTruthy();
    expect(screen.queryByText(W.confirm.key)).toBeNull();
  });

  it("gives the ticket back on every way out that is not the press, once", async () => {
    for (const leave of ["dontPair", "back", "hardware", "gone"] as const) {
      const fake = fakePhoneDoor();
      const drawn = draw(fake, { step: "scan" });
      await settle();
      act(() => fake.scan(OFFER));
      if (leave === "dontPair") press(W.confirm.dontPair);
      else if (leave === "back") press(W.back);
      else if (leave === "hardware") {
        let took = false;
        act(() => void (took = fake.back()));
        expect(took).toBe(true);
      }
      drawn.unmount();
      const given = fake.asked.filter((a) => a.kind === "dismiss");
      expect(given, leave).toEqual([{ kind: "dismiss", ask: { ticket: OFFER.ticket } }]);
    }
  });

  it("sends pair once and nothing after it; opens the copy only on ok: true", async () => {
    const offer = { ticket: OFFER.ticket, facts: OFFER.facts };
    const yes = fakePhoneDoor({ answers: { pair: () => ({ ok: true }) } });
    const drawn = draw(yes, { step: "confirm", offer });
    press(W.confirm.pair);
    await settle();
    expect(says(W.paired.say)).toBe(true);
    drawn.unmount();
    expect(yes.asked).toEqual([{ kind: "pair", ask: { ticket: OFFER.ticket } }]);
    for (const answer of [{ ok: "true" }, {}, null, { ok: false }]) {
      const no = fakePhoneDoor({ answers: { pair: () => answer as never } });
      const again = draw(no, { step: "confirm", offer });
      press(W.confirm.pair);
      await settle();
      expect(says(W.paired.say)).toBe(false);
      expect(screen.getByRole("alert").textContent).toBe(R.unknown);
      again.unmount();
      expect(no.kinds()).toEqual(["pair"]);
    }
  });

  it("says a refused pair by its code", async () => {
    const fake = fakePhoneDoor({
      answers: { pair: () => ({ ok: false, said: { code: "pairCodeRejected", args: [] } }) },
    });
    draw(fake, { step: "confirm", offer: { ticket: OFFER.ticket, facts: OFFER.facts } });
    press(W.confirm.pair);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(R.pairCodeRejected);
  });
});

describe("the mailbox on this phone", () => {
  it("is the one form for the purpose standalone, after the terms, and its connect opens the copy", async () => {
    const fake = fakePhoneDoor();
    draw(fake, { step: "terms" });
    press(W.terms.continue);
    expect(fake.connects.length).toBeGreaterThan(0);
    for (const ask of fake.connects) {
      expect(ask.purpose).toEqual({ kind: "standalone" });
      expect(Object.keys(ask).sort()).toEqual(["onDone", "purpose"]);
    }
    press("the connect form");
    expect(says(W.paired.say)).toBe(true);
    expect(fake.back()).toBe(false);
  });

  it("says where this build cannot organize on the phone, and offers only the way back", () => {
    const fake = fakePhoneDoor({ config: { organizes: "withheld" } });
    draw(fake, { step: "terms" });
    expect(screen.getByRole("alert").textContent).toBe(R.standaloneNoEngine);
    expect(screen.queryByRole("button", { name: (n) => n.startsWith(W.terms.continue) })).toBeNull();
    press(W.terms.chooseOther);
    expect(fake.asked).toEqual([{ kind: "go", ask: "servers" }]);
  });

  it("says a store's upgrade with its count while the connect waits on it, and its second line after a while", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const fake = fakePhoneDoor();
    draw(fake, { step: "mailbox" });
    act(() => fake.tell({ session: "opening", migrating: { applied: 3, pending: 12, since: 1_000_000 } }));
    expect(screen.getByText("Updating the mail store on this phone… (3 of 12)")).toBeTruthy();
    expect(screen.queryByText(W.upgrade.migratingSlow)).toBeNull();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByText(W.upgrade.migratingSlow)).toBeTruthy();
    act(() => fake.tell({ session: "live", migrating: null }));
    expect(screen.queryByText(W.upgrade.migratingSlow)).toBeNull();
  });
});

describe("back", () => {
  it("goes to the step before, to the list at the step it opened at, and is native's on the first screen", () => {
    const fake = fakePhoneDoor();
    draw(fake);
    expect(fake.back()).toBe(false);
    press(W.welcome.connect);
    let took = false;
    act(() => void (took = fake.back()));
    expect(took).toBe(true);
    expect(says(W.welcome.line.ohmail)).toBe(true);
    cleanup();
    const opened = fakePhoneDoor();
    draw(opened, { step: "computer" });
    press(W.back);
    expect(opened.asked).toEqual([{ kind: "go", ask: "servers" }]);
  });
});
