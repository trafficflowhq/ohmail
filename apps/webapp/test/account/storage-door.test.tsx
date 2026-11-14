/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk, StorageModel } from "@ohmail/app/account";
import { StoragePane, useStorage } from "../../../../packages/app/src/account/storage/index.js";
import { en, json, OFFLINE, published, refusal, serve, settle, Words, type Server } from "./storage-harness";
import { NEAR, open, ROSTER } from "./storage-fixtures";

/**
 * SETTINGS › STORAGE OVER THE WEB'S OWN FILLING (`storage-door.ts`), each guard of the shipped card with its case:
 * the change is tried first and the factor asked only on the server's refusal, the parked change sent once, a second
 * refusal said and never asked again, Cancel and a late factor sending nothing, a pane left sending nothing; an
 * address not confirmed said apart; no address is "could not open"; the address itself in no node, no model and no
 * log; the storage mails written once and put back on a refusal; nothing asked to draw the pane.
 */

let roster: unknown[] | null = ROSTER;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", () => ({ useMailboxFacts: () => roster }));

const CHANGE = "POST /api/account/manage-link/change";
const WRITE = "PATCH /api/account/storage";
const ACCESS = "GET /api/account/access";
const PAGE = "https://pay.example.com/manage/t-change";
const STEP_UP = () => refusal(403, "step_up_required");

let server: Server;
let access: Record<string, unknown> = open(NEAR);
/** What the factor's slot was last handed, and the model the pane last drew. */
let asked: GatedAsk | null = null;
let drawnModel: StorageModel | null = null;
const factor: FactorSlot = (ask) => {
  asked = ask;
  return <p role="dialog" aria-label="factor" />;
};

beforeEach(() => {
  access = open(NEAR);
  roster = ROSTER;
  asked = null;
  drawnModel = null;
  server = serve(() => access);
});
afterEach(() => {
  cleanup();
  server.restore();
});

/** Settings › Storage as the web will mount it: the real filling, the hook, the pane. */
async function mounted(body: "pane" | "facts" = "pane") {
  const { useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
  function Body() {
    const model = useStorage(useStorageDoor(null));
    drawnModel = model;
    return <StoragePane model={model} body={body} factor={factor} />;
  }
  await published();
  server.forget();
  return render(
    <Words>
      <Body />
    </Words>,
  );
}
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await settle();
};
const verified = () => act(async () => asked!.onVerified());
const factorShown = () => screen.queryByRole("dialog", { name: "factor" }) !== null;
const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const theSwitch = () => screen.getByRole("switch", { name: en.settings.storageMail });

describe("the door's answers to the change, as words (each read in the shipped card's order)", () => {
  const cases: [string, Response | typeof OFFLINE, unknown][] = [
    ["an address leaves", json({ url: PAGE }), { ok: true, value: "left" }],
    ["an empty address is no address", json({ url: "" }), { ok: false, word: "failed" }],
    ["an answer without an address", json({}), { ok: false, word: "failed" }],
    ["no such page here", refusal(404, "not_found"), { ok: false, word: "failed" }],
    ["the factor is stale", STEP_UP(), { ok: false, word: "factor" }],
    ["the address is not confirmed", refusal(403, "email_unverified"), { ok: false, word: "unverified" }],
    ["another refusal of the gate", refusal(403, "forbidden"), { ok: false, word: "failed" }],
    ["the server broke", refusal(500, "internal"), { ok: false, word: "failed" }],
    ["no server answered", OFFLINE, { ok: false, word: "failed" }],
  ];
  for (const [what, answer, word] of cases) {
    it(what, async () => {
      const { useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
      server.answer(CHANGE, answer);
      const { result } = renderHook(() => useStorageDoor(null), { wrapper: Words });
      let got: unknown = null;
      await act(async () => {
        got = await result.current.change();
      });
      expect(got).toEqual(word);
      expect(server.on(CHANGE).map((s) => s.keys)).toEqual([["lang"]]);
      expect(server.left).toEqual(what === "an address leaves" ? [{ href: PAGE, rel: "noreferrer", target: "" }] : []);
    });
  }

  it("names the page's language and nothing else", async () => {
    const { useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
    server.answer(CHANGE, json({ url: PAGE }));
    const { result } = renderHook(() => useStorageDoor(null), { wrapper: Words });
    await act(async () => {
      await result.current.change();
    });
    expect(server.on(CHANGE).map((s) => s.body)).toEqual([{ lang: "en" }]);
  });
});

describe("the plan's change over the real filling", () => {
  it("asks nothing to draw the pane", async () => {
    await mounted();
    expect(screen.getByRole("button", { name: en.settings.storageChangePlan })).toBeTruthy();
    await settle();
    expect(server.sent).toEqual([]);
  });

  it("refused for the factor: one request, the factor asked, nothing more until it verifies, then one more alike", async () => {
    server.answer(CHANGE, STEP_UP(), json({ url: PAGE }));
    await mounted();
    await press(en.settings.storageChangePlan);
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(factorShown()).toBe(true);
    await settle();
    expect(server.on(CHANGE)).toHaveLength(1);
    await verified();
    await settle();
    expect(server.sent.map((s) => [s.line, s.keys])).toEqual([
      [CHANGE, ["lang"]],
      [CHANGE, ["lang"]],
    ]);
    expect(server.left).toEqual([{ href: PAGE, rel: "noreferrer", target: "" }]);
    expect(factorShown()).toBe(false);
  });

  it("refused again after the factor: says so, asks no second time, sends nothing more", async () => {
    server.answer(CHANGE, STEP_UP(), STEP_UP(), json({ url: PAGE }));
    await mounted();
    await press(en.settings.storageAddStorage);
    await verified();
    await settle();
    expect(server.on(CHANGE)).toHaveLength(2);
    expect(factorShown()).toBe(false);
    expect(seen(en.settings.storageChangeFailed)).toBe(true);
    expect(seen(en.devices.stepUpExpired)).toBe(false);
    expect(server.left).toEqual([]);
  });

  it("Cancel sends nothing; a factor after Cancel says nothing ran and sends nothing", async () => {
    server.answer(CHANGE, STEP_UP(), json({ url: PAGE }));
    await mounted();
    await press(en.settings.storageChangePlan);
    const ask = asked!;
    await act(async () => ask.onCancel());
    await settle();
    expect(factorShown()).toBe(false);
    await act(async () => ask.onDiscarded());
    await act(async () => ask.onVerified());
    await settle();
    expect(seen(en.devices.stepUpCancelledNothingRan)).toBe(true);
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(server.left).toEqual([]);
  });

  it("a pane left while the factor is asked sends nothing afterwards", async () => {
    server.answer(CHANGE, STEP_UP(), json({ url: PAGE }));
    const { unmount } = await mounted();
    await press(en.settings.storageChangePlan);
    const ask = asked!;
    unmount();
    await act(async () => ask.onVerified());
    await settle();
    expect(server.on(CHANGE)).toHaveLength(1);
    expect(server.left).toEqual([]);
  });

  it("says an address that is not confirmed in its own sentence", async () => {
    server.answer(CHANGE, refusal(403, "email_unverified"));
    await mounted();
    await press(en.settings.storageChangePlan);
    expect(seen(en.accessLock.mintUnverified)).toBe(true);
    expect(seen(en.settings.storageChangeFailed)).toBe(false);
    expect(factorShown()).toBe(false);
  });

  it("says no address as a page that could not be opened, and leaves for none", async () => {
    for (const answer of [json({ url: "" }), refusal(404, "not_found"), json({})]) {
      server.answer(CHANGE, answer);
      await mounted();
      await press(en.settings.storageChangePlan);
      expect(seen(en.settings.storageChangeFailed)).toBe(true);
      cleanup();
    }
    expect(server.left).toEqual([]);
  });

  it("keeps the account page's address out of every node, the model and the log", async () => {
    const lines: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args)),
    );
    server.answer(CHANGE, STEP_UP(), json({ url: PAGE }));
    await mounted();
    await press(en.settings.storageChangePlan);
    await verified();
    await settle();
    expect(server.left.map((l) => l.href)).toEqual([PAGE]);
    expect(document.documentElement.outerHTML).not.toContain("pay.example.com");
    expect(JSON.stringify(drawnModel)).not.toContain("pay.example.com");
    expect(JSON.stringify(lines)).not.toContain("pay.example.com");
    for (const spy of spies) spy.mockRestore();
  });
});

describe("the storage mails' switch over the real filling", () => {
  it("writes once with the key mail, then asks the access answer fresh, and holds what it wrote", async () => {
    await mounted();
    expect(theSwitch().getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(theSwitch());
    });
    await settle();
    expect(server.sent.map((s) => [s.line, s.keys])).toEqual([
      [WRITE, ["mail"]],
      [ACCESS, []],
    ]);
    expect(server.on(WRITE)[0]!.body).toEqual({ mail: false });
    // The answer read afterwards still says on: what was written holds.
    expect(theSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("goes back and says so when the write is refused, and asks nothing more", async () => {
    server.answer(WRITE, refusal(500, "internal"));
    await mounted();
    await act(async () => {
      fireEvent.click(theSwitch());
    });
    await settle();
    expect(server.sent.map((s) => s.line)).toEqual([WRITE]);
    expect(theSwitch().getAttribute("aria-checked")).toBe("true");
    expect(seen(en.settings.storageMailFailed)).toBe(true);
  });
});

describe("where the pane is drawn", () => {
  it("draws nothing where the access answer carries no storage block", async () => {
    access = open(undefined);
    const { container } = await mounted();
    expect(container.textContent).toBe("");
  });

  it("follows the account the shell hands in, never another account's answer", async () => {
    const { useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
    await published();
    const { result } = renderHook(() => useStorageDoor("someone-else"), { wrapper: Words });
    expect(result.current.figures.read()).toBeNull();
  });
});
