/** @vitest-environment jsdom */
/**
 * THE RULING'S SECURITY CASE 2, ON THE WAYS IN: a typed pairing code and a pasted link, each through its blank (the
 * server step's way to a code by hand, and the scan's link by hand), cross ONCE, in the one `hand` of their press.
 * After the press neither stands in the blank, in the markup, in anything React holds for the page (its state and
 * its props), in the address or the history, in a storage or a cookie, or in a console line. What native answers
 * is drawn from what it measured, never from what was typed. A whole link pasted into an address blank leaves that
 * blank at the press too: by hand it goes as the token, and the server step's one ask carries it as typed.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "../../src/text/index.js";
import { PhoneDoorPage, type WayInSeed } from "../../src/phone-door/index.js";
import phone from "../../messages/phone.en.json" with { type: "json" };
import { fakePhoneDoor } from "../support/phone-door.js";

const W = phone.phoneDoor;
/** The markers: made up, no server knows them. */
const MARK = "zq-MARKER";
const TYPED = `${MARK}-code-9Hp2`;
const PASTED = `https://oh.lichtgrat.example/pair#${MARK}-link-5Tc1`;
const OFFER = {
  k: "offers" as const,
  ticket: "c".repeat(32),
  facts: { what: "server" as const, address: "https://oh.lichtgrat.example", key: null },
};

const settle = (): Promise<void> => act(async () => {});
/** A press by the button's name; a button that carries its key's hint ("↵") is named by its words. */
const press = (name: string): void =>
  void fireEvent.click(screen.getByRole("button", { name: (n) => n.replace(/\s*↵$/, "") === name }));
const type = (label: string, value: string): void =>
  void fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Every string React holds for the drawn page: each part's props and state, followed through objects and arrays. */
function heldByReact(container: HTMLElement): string[] {
  const node = container.querySelector("*");
  const key = node ? Object.keys(node).find((k) => k.startsWith("__reactFiber$")) : undefined;
  if (!node || !key) throw new Error("no part of React drawn");
  let top = (node as unknown as Record<string, Fiber>)[key]!;
  while (top.return) top = top.return;
  const found: string[] = [];
  const seen = new Set<unknown>();
  const SKIP = new Set([
    "return",
    "child",
    "sibling",
    "alternate",
    "stateNode",
    "_owner",
    "_store",
    "dependencies",
  ]);
  const read = (v: unknown, depth: number): void => {
    if (typeof v === "string") return void found.push(v);
    if (typeof v !== "object" || v === null || depth > 12 || seen.has(v) || v instanceof Node) return;
    seen.add(v);
    for (const [k, inner] of Object.entries(v))
      if (!SKIP.has(k) && !k.startsWith("_debug")) read(inner, depth + 1);
  };
  const walk = (fiber: Fiber | null): void => {
    for (let f = fiber; f; f = f.sibling) {
      read(f.memoizedProps, 0);
      read(f.memoizedState, 0);
      walk(f.child);
    }
  };
  walk(top);
  return found;
}
interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
}

/** Every way out of the page a marker could take, watched from before the page draws. */
function watchTheWaysOut() {
  const out: string[] = [];
  const keep =
    (where: string) =>
    (...args: unknown[]) =>
      void out.push(`${where} ${args.map(String).join(" ")}`);
  for (const verb of ["setItem"] as const)
    vi.spyOn(Storage.prototype, verb).mockImplementation(keep(`storage.${verb}`));
  vi.spyOn(history, "pushState").mockImplementation(keep("history.pushState"));
  vi.spyOn(history, "replaceState").mockImplementation(keep("history.replaceState"));
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation(keep(`console.${level}`));
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "", set: keep("cookie") });
  return {
    out,
    restore: () => Object.defineProperty(document, "cookie", cookie),
  };
}

function draw(fake: ReturnType<typeof fakePhoneDoor>, from: WayInSeed) {
  return render(
    <TextProvider locale="en" messages={phone as never} timeZone="UTC">
      <PhoneDoorPage door={fake.door} from={from} />
    </TextProvider>,
  );
}

/** Where a marker stands now, outside the one `hand` it crossed in. */
function whereItStands(container: HTMLElement, out: readonly string[]): string[] {
  const inputs = [...container.querySelectorAll("input")].map((el) => el.value);
  const places: [string, readonly string[]][] = [
    ["markup", [container.innerHTML]],
    ["a blank", inputs],
    ["React", heldByReact(container)],
    ["the address", [location.href]],
    ["a way out", out],
  ];
  return places.flatMap(([place, texts]) => (texts.some((t) => t.includes(MARK)) ? [place] : []));
}

let ways: ReturnType<typeof watchTheWaysOut>;
beforeEach(() => {
  ways = watchTheWaysOut();
});
afterEach(() => {
  cleanup();
  ways.restore();
  vi.restoreAllMocks();
});

describe("a typed pairing code and a pasted link on the ways in", () => {
  it("cross once each, in the body of hand, through the server step's code by hand; then they stand nowhere", async () => {
    const answers = [{ k: "refused" as const, said: { code: "pairCodeRejected", args: [] } }, OFFER];
    const fake = fakePhoneDoor({
      answers: {
        "server.ask": () => ({
          k: "reached",
          address: "oh.lichtgrat.example",
          flavor: "selfhost",
          apiUnder: null,
        }),
        hand: () => answers.shift()!,
      },
    });
    const { container } = draw(fake, { step: "server" });
    type(W.server.label, "oh.lichtgrat.example");
    press(W.server.continue);
    await settle();
    press(W.server.token);
    type(W.hand.tokenLabel, TYPED);
    press(W.hand.pair);
    await settle();
    expect(whereItStands(container, ways.out)).toEqual([]);
    type(W.hand.tokenLabel, PASTED);
    press(W.hand.pair);
    await settle();
    expect(screen.getByText(OFFER.facts.address)).toBeTruthy();
    expect(whereItStands(container, ways.out)).toEqual([]);
    const crossed = fake.asked.filter((a) => JSON.stringify(a).includes(MARK));
    expect(crossed).toEqual([
      { kind: "hand", ask: { address: "oh.lichtgrat.example", token: TYPED } },
      { kind: "hand", ask: { address: "oh.lichtgrat.example", token: PASTED } },
    ]);
  });

  it("cross once, in the body of hand, through the scan's link by hand; then it stands nowhere", async () => {
    const fake = fakePhoneDoor({ answers: { hand: () => OFFER } });
    const { container } = draw(fake, { step: "scan" });
    await settle();
    press(W.scan.byHand);
    type(W.scan.linkLabel, PASTED);
    expect((screen.getByLabelText(W.scan.linkLabel) as HTMLInputElement).type).toBe("password");
    press(W.scan.pair);
    await settle();
    expect(screen.getByText(OFFER.facts.address)).toBeTruthy();
    expect(whereItStands(container, ways.out)).toEqual([]);
    expect(fake.asked.filter((a) => JSON.stringify(a).includes(MARK))).toEqual([
      { kind: "hand", ask: { address: null, token: PASTED } },
    ]);
  });

  it("is a password's blank in both places, named by nothing a form could post", () => {
    const fake = fakePhoneDoor();
    draw(fake, { step: "hand" });
    const blank = screen.getByLabelText(W.hand.tokenLabel) as HTMLInputElement;
    expect(blank.type).toBe("password");
    expect(blank.name).toBe("");
  });

  it("leave an address blank at the press when the whole link was pasted there: by hand it goes as the token, and the server step's blank is emptied", async () => {
    // Neither request is answered: what the page holds is read right after the press.
    const hand = fakePhoneDoor();
    const byHand = draw(hand, { step: "hand" });
    type(W.hand.addressLabel, PASTED);
    press(W.hand.pair);
    await settle();
    expect(whereItStands(byHand.container, ways.out)).toEqual([]);
    expect(hand.asked).toEqual([{ kind: "hand", ask: { address: null, token: PASTED } }]);
    byHand.unmount();
    const server = fakePhoneDoor();
    const { container } = draw(server, { step: "server" });
    type(W.server.label, PASTED);
    press(W.server.continue);
    await settle();
    expect(whereItStands(container, ways.out)).toEqual([]);
    expect(server.asked).toEqual([{ kind: "server.ask", ask: { address: PASTED } }]);
  });
});
