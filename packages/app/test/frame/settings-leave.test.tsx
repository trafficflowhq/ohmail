/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { useFrame } from "../../src/frame/commands.js";
import { fragmentOf } from "../../src/frame/route.js";
import type { PaneProps, PlaceEntry, RouteTarget } from "../../src/frame/contract.js";
import { fragmentAddress } from "../../src/host/browser/index.js";
import {
  AwayPane,
  AWAY_STATE_RULES,
  awayStates,
  awayStep,
  useAwayLeave,
  type AwayEvent,
  type AwayState,
} from "../../src/settings/away/index.js";
import awayWords from "../../messages/settings-away.en.json" with { type: "json" };
import { SignaturesPane, signaturesState } from "../../src/settings/signatures/index.js";
import { TextProvider } from "../../src/text/index.js";
import settings from "../../messages/settings.en.json" with { type: "json" };
import signatures from "../../messages/settings-signatures.en.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const at = "#/settings/signatures";
const words = settings.settings.signatures;
const save = vi.fn(async () => {});
const targets: readonly RouteTarget[] = [
  { place: "ohbox" },
  { place: "tags", sub: "one" },
  { place: "folder", sub: "two" },
  { place: "address", sub: "sender" },
  { place: "screener", sub: "spam" },
  { place: "later" },
  { place: "settings", sub: "away" },
  { place: "ohbox", stage: { id: "firstRun", words: { how: "add" } } },
  { place: "drafts" },
  { place: "history" },
  { place: "search" },
  { place: "receipts" },
  { place: "parked" },
];
function fragment(to: RouteTarget) {
  return fragmentOf({ sub: null, open: null, stage: null, words: {}, ...to });
}
const away = "#/settings/away";
const awayModel = awayStates({ body: "Back Monday", date: "", host: "" }).rest.model;
function Away() {
  const { host, commands } = useFrame();
  const [state, step] = useReducer(
    (s: AwayState, event: AwayEvent) => awayStep(s, event, AWAY_STATE_RULES),
    awayModel.state,
  );
  const guard = useAwayLeave(host.device.address, state, AWAY_STATE_RULES, () => step({ kind: "discard" }));
  return (
    <>
      <AwayPane
        model={{
          ...awayModel,
          state,
          ...guard,
          edit: (patch) => step({ kind: "edit", patch }),
          save: () => {
            const row = state.draft!;
            step({ kind: "save", now: Date.now() });
            void save().then(
              () => step({ kind: "echoed", row, travelled: false }),
              () => step({ kind: "refusedWrite" }),
            );
          },
        }}
        rules={AWAY_STATE_RULES}
      />
      <button onClick={() => commands.go({ place: "settings", sub: "signatures" })}>Other section</button>
    </>
  );
}
function Wide({ route }: PaneProps) {
  const { host, commands } = useFrame();
  if (route.place === "settings" && route.sub === "away") return <Away />;
  if (route.place !== "settings" || (route.sub && route.sub !== "signatures")) return <p>Left Settings</p>;
  const model = signaturesState();
  return (
    <>
      <SignaturesPane
        model={{
          ...model,
          write: async (id, text, html) => {
            await save();
            return { signatures: { [id]: text ?? "" }, signaturesHtml: { [id]: html ?? "" } };
          },
          holdLeave: (ask) => host.device.address.holdLeave(ask, at),
        }}
      />
      {targets.map((to) => (
        <button key={fragment(to)} onClick={() => commands.go(to)}>
          {fragment(to)}
        </button>
      ))}
      <button onClick={() => commands.go({ place: "settings", sub: "signatures" })}>Current section</button>
    </>
  );
}
function mount() {
  const address = {
    ...fragmentAddress(window),
    writes: [],
    visit: (next: string) => {
      window.location.hash = next;
    },
  };
  const places = Object.fromEntries(
    ["settings", ...targets.map((t) => t.place)].map((id) => [
      id,
      { id, body: id, rail: null, panes: { kind: "wide", Wide } } as PlaceEntry,
    ]),
  );
  const made = fakeHost({
    service: "self",
    scope: "account-a",
    engine: NO_ENGINE,
    window: fakeWindow("desktop"),
    address,
    places,
  });
  const view = (scope: string | null) => (
    <TextProvider
      locale="en"
      messages={{ ...FRAME_WORDS.en, ...settings, ...signatures, ...awayWords }}
      timeZone="UTC"
    >
      <Frame host={{ ...made.host, session: { ...made.host.session, scope } }} />
    </TextProvider>
  );
  const mounted = render(view("account-a"));
  return (scope: string | null) => mounted.rerender(view(scope));
}
function edit() {
  const field = screen.getAllByRole("textbox")[0]!;
  fireEvent.change(field, { target: { value: "unsaved signature" } });
  return field as HTMLTextAreaElement;
}
function press(word: string) {
  fireEvent.click(screen.getByRole("button", { name: word }));
}
function answer(word: string) {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: word }));
}
beforeEach(() => {
  save.mockClear();
  window.history.replaceState(null, "", at);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#");
});
it.each(targets.map((to) => [fragment(to)] as const))(
  "keeps the edit until discard on the route %s",
  async (next) => {
    mount();
    const field = edit();
    const depth = window.history.length;
    press(next);
    expect(window.location.hash).toBe(at);
    expect(window.history.length).toBe(depth);
    answer(words.leaveKeep);
    expect(field.value).toBe("unsaved signature");
    expect(screen.queryByRole("dialog")).toBeNull();
    press(next);
    answer(words.revert);
    await waitFor(() => expect(window.location.hash).toBe(next));
    expect(save).not.toHaveBeenCalled();
  },
);
it("keeps a dirty section on its own route and asks on browser Back and a link", async () => {
  window.history.replaceState(null, "", "#/history");
  fragmentAddress(window).write(at, "push");
  mount();
  edit();
  press("Current section");
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(window.location.hash).toBe(at);
  answer(words.leaveKeep);
  await act(async () => {
    window.location.hash = "#/drafts";
    await new Promise((r) => setTimeout(r, 25));
  });
  expect(window.location.hash).toBe(at);
  answer(words.revert);
  await waitFor(() => expect(window.location.hash).toBe("#/drafts"));
  expect(save).not.toHaveBeenCalled();
});
it("asks on reload only while the edit differs from its stored signature", () => {
  const closing = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  mount();
  expect(closing()).toBe(false);
  const field = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
  const stored = field.value;
  edit();
  expect(closing()).toBe(true);
  fireEvent.change(field, { target: { value: stored } });
  expect(closing()).toBe(false);
  press("#/history");
  expect(window.location.hash).toBe("#/history");
});

it("keeps the unsaved responder on its section and leaves only on discard, without sending a write", async () => {
  window.history.replaceState(null, "", away);
  mount();
  const toggle = screen.getByRole("switch", { name: settings.away.title });
  fireEvent.click(toggle);
  expect(screen.getByText(settings.away.off)).toBeTruthy();
  press("Other section");
  expect(window.location.hash).toBe(away);
  press(settings.away.leaveKeep);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  press("Other section");
  press(settings.away.leaveDiscard);
  await waitFor(() => expect(window.location.hash).toBe(at));
  expect(save).not.toHaveBeenCalled();
});

it("keeps the previous and following entries through Back, Keep editing and Discard", async () => {
  window.history.replaceState(null, "", "#/history");
  fragmentAddress(window).write(at, "push");
  mount();
  edit();
  async function traverse(direction: "back" | "forward") {
    await act(async () => {
      window.history[direction]();
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  }
  await traverse("back");
  answer(words.leaveKeep);
  expect(window.location.hash).toBe(at);
  await traverse("back");
  answer(words.revert);
  await waitFor(() => expect(window.location.hash).toBe("#/history"));
  await traverse("forward");
  await waitFor(() => expect(window.location.hash).toBe(at));
  expect(save).not.toHaveBeenCalled();
});

it("stays with both signatures while a save is pending or refused", async () => {
  let refuse!: (reason: Error) => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((_, no) => {
        refuse = no;
      }),
  );
  mount();
  const [first, second] = screen
    .getAllByRole("textbox")
    .filter((el) => !(el as HTMLTextAreaElement).readOnly);
  fireEvent.change(first!, { target: { value: "first draft" } });
  fireEvent.change(second!, { target: { value: "second draft" } });
  fireEvent.click(
    within(first!.closest(".oh-settingssheet") as HTMLElement).getByRole("button", { name: words.save }),
  );
  press("#/history");
  expect(window.location.hash).toBe(at);
  answer(words.leaveKeep);
  await act(async () => refuse(new Error("refused")));
  expect((first as HTMLTextAreaElement).value).toBe("first draft");
  expect((second as HTMLTextAreaElement).value).toBe("second draft");
  press("#/history");
  answer(words.leaveKeep);
  expect(window.location.hash).toBe(at);
  fireEvent.click(
    within(first!.closest(".oh-settingssheet") as HTMLElement).getByRole("button", { name: words.save }),
  );
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  press("#/history");
  expect(window.location.hash).toBe(at);
  answer(words.revert);
  expect(window.location.hash).toBe("#/history");
});

it("retains an Away change through a delayed refusal and releases it after retry confirms the row", async () => {
  let reject!: (error: Error) => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((_, no) => {
        reject = no;
      }),
  );
  window.history.replaceState(null, "", away);
  mount();
  fireEvent.click(screen.getByRole("switch", { name: settings.away.title }));
  fireEvent.click(screen.getAllByRole("button", { name: settings.away.save })[0]!);
  press("Other section");
  expect(window.location.hash).toBe(away);
  press(settings.away.leaveKeep);
  await act(async () => reject(new Error("refused")));
  expect(screen.getByRole("switch", { name: settings.away.title }).getAttribute("aria-checked")).toBe("true");
  press("Other section");
  press(settings.away.leaveKeep);
  await act(async () => fireEvent.click(screen.getAllByRole("button", { name: settings.away.save })[0]!));
  expect(save).toHaveBeenCalledTimes(2);
  press("Other section");
  await waitFor(() => expect(window.location.hash).toBe(at));
});

it("holds a traversal with a different page query and retains both complete URLs", async () => {
  const other = "/mailbox?view=earlier#/history";
  const here = "/mailbox?view=edited" + at;
  window.history.replaceState({ mark: "before" }, "", other);
  window.history.pushState({ mark: "edit" }, "", here);
  vi.stubGlobal("navigation", {
    get currentEntry() {
      return { index: history.state?.mark === "edit" ? 1 : 0 };
    },
  });
  mount();
  edit();
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await waitFor(() => expect(location.pathname + location.search + location.hash).toBe(here));
  answer(words.revert);
  await waitFor(() => expect(location.pathname + location.search + location.hash).toBe(other));
  expect(history.state).toEqual({ mark: "before" });
  await act(async () => {
    window.history.forward();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(location.pathname + location.search + location.hash).toBe(here);
  expect(history.state).toEqual({ mark: "edit" });
});

async function opaqueForward() {
  history.replaceState({ section: "edited" }, "", at);
  history.pushState({ section: "visited" }, "", "#/history");
  history.back();
  await waitFor(() => expect(location.hash).toBe(at));
  const changeOwner = mount();
  const field = edit();
  field.focus();
  await act(async () => history.forward());
  await screen.findByRole("dialog");
  return { field, changeOwner };
}
it("keeps the editor at the visited URL when a pre-existing history position is opaque, and discards to that entry", async () => {
  const { field } = await opaqueForward();
  const depth = history.length;
  expect(location.hash).toBe("#/history");
  answer(words.leaveKeep);
  expect(field.value).toBe("unsaved signature");
  expect(document.activeElement).toBe(field);
  expect(history.state).toEqual({ section: "visited" });
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
  await act(async () => history.back());
  await waitFor(() => expect(location.hash).toBe(at));
  await act(async () => history.forward());
  await screen.findByRole("dialog");
  answer(words.revert);
  await screen.findByText("Left Settings");
  expect(history.length).toBe(depth);
  expect(history.state).toEqual({ section: "visited" });
  expect(save).not.toHaveBeenCalled();
  await act(async () => history.back());
  await waitFor(() => expect(history.state).toEqual({ section: "edited" }));
});
it("retires the held draft on sign-out and never draws it for the next account", async () => {
  const { changeOwner } = await opaqueForward();
  answer(words.leaveKeep);
  changeOwner(null);
  expect(screen.queryByDisplayValue("unsaved signature")).toBeNull();
  changeOwner("account-b");
  await screen.findByText("Left Settings");
  expect(screen.queryByDisplayValue("unsaved signature")).toBeNull();
  expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(true);
  await act(async () => history.back());
  await screen.findAllByRole("textbox");
  expect(screen.queryByDisplayValue("unsaved signature")).toBeNull();
});
