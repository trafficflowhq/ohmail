/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import * as React from "react";
import messages from "../messages/en.json";
import { stubDom } from "./_draft-shell.js";
import { mountWriting, rounds, unmountWritings } from "./_write-1-writing.js";
import { formatRecipientChips } from "@ohmail/app-logic/writing/compose-from";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";

const ADDRESS_MAX = 34;
const act = React.act;
let world: Awaited<ReturnType<typeof mountWriting>>;

async function render(initial = ""): Promise<void> {
  stubDom();
  world = await mountWriting({ view: true });
  await act(async () => {
    world.now().onComposeFields({ ...world.now().compose, to: initial });
  });
  await rounds(6);
}

const line = () => within(within(world.el).getByRole("group", { name: messages.write.to }));
const input = () =>
  line().queryByRole<HTMLInputElement>("combobox", { name: messages.write.to }) ??
  line().getByRole<HTMLInputElement>("textbox", { name: messages.write.to });
const chips = () => line().queryAllByRole("button").filter((button) => button.getAttribute("aria-haspopup") === "menu");
const entries = () => chips().map((chip) => chip.getAttribute("data-person")?.split("\0").slice(2).join("\0"));
const labels = () => chips().map((chip) => chip.querySelector(".oh-recipients-name")!.textContent ?? "");

async function type(text: string): Promise<void> {
  await act(async () => { fireEvent.change(input(), { target: { value: text } }); });
}

afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});

describe("a field seeded from stored addresses is ALL chips — CMP-F3", () => {
  it("taking the offered draft fills the letter, keeps From and acknowledges the original draft", async () => {
    stubDom();
    const to = [{ name: "Pat", address: "pat" + "@" + "example.test" }];
    const cc = [{ name: "Sam", address: "sam" + "@" + "example.test" }];
    const draft = {
      id: "draft-compose", mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
      subject: "Friday's plans", body: "Shall we meet on Friday? <b>", rationale: null,
      to, cc, bcc: [], status: "draft" as const,
      createdAt: "2026-09-07T09:00:00.000Z", updatedAt: "2026-09-07T09:00:00.000Z",
    };
    world = await mountWriting({ view: true, secondMailbox: true, drafts: [draft] });
    await act(async () => {
      world.now().onComposeFields({ ...world.now().compose, fromMailboxId: "mb2", body: "Old words", html: "<b>Old words</b>" });
    });
    await rounds(6);
    const view = within(world.el);
    const offer = await view.findByRole("button", { name: "Use draft" });
    await act(async () => { fireEvent.click(offer); });
    await rounds(6);

    expect(view.getByRole("textbox", { name: "Subject" })).toHaveProperty("value", draft.subject);
    expect(line().getByRole("button", { name: /^Pat / })).toBeTruthy();
    expect(world.now().compose.to).toBe(formatRecipientChips(to));
    expect(world.now().compose).toMatchObject({
      fromMailboxId: "mb2", cc: formatRecipientChips(cc), body: draft.body, html: "",
    });
    expect(world.sent.filter((act) => act.kind === "draft_accept")).toEqual([
      { kind: "draft_accept", draftId: draft.id },
    ]);
    expect(view.queryByRole("button", { name: "Use draft" })).toBeNull();
  });

  it("every address-seeding surface goes through formatRecipientChips: an accepted AI draft", async () => {
    stubDom();
    const stored = ["one", "two"].map((local) => ({ name: null, address: local + "@example.test" }));
    const seed = formatRecipientChips(stored);
    const draft = "Shall we meet on Friday?";
    world = await mountWriting({
      view: true,
      draftWire: {
        configured: () => true,
        create: async () => ({ draftId: "reply" }),
        fromText: async () => ({ draftId: "letter" }),
        read: async () => ({ body: draft, html: null }),
      },
    });
    await act(async () => {
      world.now().onComposeFields({ ...world.now().compose, to: seed, body: "meet Fri?" });
    });
    await rounds(6);
    expect(entries()).toEqual(stored.map(({ address }) => address));
    await act(async () => {
      fireEvent.click(within(world.el).getByRole("button", { name: messages.write.draft.fromText }));
    });
    await rounds(10);
    expect(world.now().compose.body).toBe(draft);
    expect(world.now().compose.to).toBe(seed);
    expect(entries()).toEqual(stored.map(({ address }) => address));
    expect(input().value).toBe("");
  });
});

describe("chips: every settled recipient is one", () => {
  it("blur commits the tail — leaving the field finishes the entry", async () => {
    await render();
    await type("nadia@parc.invalid");
    // `focusout`, not a hand-built `blur`: React 18 delegates onBlur through focusout, so a
    // synthetic `blur` event never reaches the handler (the same note as the focus test).
    await act(async () => { input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(entries()).toEqual(["nadia@parc.invalid"]);
  });

  it("shows the DISPLAY-DECODED address on the chip face and keeps the wire form underneath", async () => {
    // The IDN rule: decode for SHOW, never for the value. `xn--bcher-kva.example` reads
    // `bücher.example`; the entry — what travels on drag, into the string, onto the wire — stays
    // the stored A-label byte-for-byte.
    await render("nora@xn--bcher-kva.example, ");
    const chip = chips()[0]!;
    expect(chip.textContent).toContain("nora@bücher.example");
    expect(entries()[0]).toBe("nora@xn--bcher-kva.example");
    expect(world.now().compose.to).toContain("xn--bcher-kva.example");
    expect(world.now().compose.to).not.toContain("bücher");
  });
});

describe("keyboard: chips are reachable, removable and movable without a mouse", () => {
  it("is announced: the chips ride a listbox, each one an option with its name", async () => {
    // The mounted editor follows the studio recipient button pattern. The title is the retirement ledger key.
    const address = "a@x.invalid";
    await render(address + ", ");
    const chip = line().getByRole("button", { name: address });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => { input().focus(); fireEvent.keyDown(input(), { key: "ArrowLeft" }); });
    expect(document.activeElement).toBe(chip);
    await act(async () => { fireEvent.keyDown(chip, { key: "Delete" }); });
    expect(entries()).toEqual([]);
    expect(document.activeElement).toBe(input());
  });
});

describe("the combobox", () => {
  it("reports focus, so the form can hold back the error for a half-typed entry", async () => {
    // A partial address should stay quiet while the person is still typing on the line.
    await render();
    await act(async () => { input().focus(); });
    expect(document.activeElement).toBe(input());
    await type("no");
    expect(within(world.el).queryByText("Not an address", { exact: false })).toBeNull();
    await act(async () => { input().blur(); });
    expect(within(world.el).queryByText("Not an address", { exact: false })).not.toBeNull();
  });
});

describe("the address is shown so recipients can be told apart", () => {
  it("leaves a short address alone", async () => {
    const address = "lena@atelier.invalid";
    stubDom();
    const world = await mountWriting({ view: true });
    await act(async () => world.now().onComposeFields({ ...world.now().compose, to: address + ", " }));
    await rounds(6);

    const to = within(within(world.el).getByRole("group", { name: messages.write.to }));
    const chip = to.getByRole("button", { name: address });
    expect(within(chip).getByText(address, { exact: true }).textContent).toBe(address);
  });

  it("middle-truncates the local part and keeps the whole domain", async () => {
    await render("verylonglocalpartthatexceeds@company.example.com" + ", ");
    const [label] = labels();
    // The domain is the part that tells a work address from a personal one — it is never dropped.
    expect(label!.endsWith("@company.example.com")).toBe(true);
    // …and the cut is in the MIDDLE of the local part, not at the end where the browser would put it.
    expect(label).toContain("…");
    expect(label!.startsWith("very")).toBe(true);
    expect(label!.length).toBeLessThanOrEqual(ADDRESS_MAX + 1);
  });

  it("never shows two different addresses as the same string", async () => {
    // Same domain, same local head and tail, differing only in a middle that a lone truncation
    // would drop — so on their own they collapse to one string. In a mail client that is a
    // wrong-recipient risk, so the list must widen them until they are distinct.
    const a = "abcdefghijXXXXXklmnopqrst@example.com";
    const b = "abcdefghijYYYYYklmnopqrst@example.com";
    await render(a + ", ");
    const [single] = labels();
    await act(async () => { world.now().onComposeFields({ ...world.now().compose, to: b + ", " }); });
    expect(single, "the premise: alone, these collide").toBe(labels()[0]);

    await act(async () => { world.now().onComposeFields({ ...world.now().compose, to: `${a}, ${b}, ` }); });
    const together = labels();
    expect(new Set(together).size, "two recipients rendered as one string").toBe(2);
    expect(together).toContain(a);
    expect(together).toContain(b);
  });

  it("keeps addresses on different domains distinct, domains intact", async () => {
    await render([
      "jordan.the.very.long.name@work.example.org",
      "jordan.the.very.long.name@home.example.org",
    ].join(", ") + ", ");
    const shown = labels();
    expect(new Set(shown).size).toBe(2);
    expect(shown[0]!.endsWith("@work.example.org")).toBe(true);
    expect(shown[1]!.endsWith("@home.example.org")).toBe(true);
  });
});
