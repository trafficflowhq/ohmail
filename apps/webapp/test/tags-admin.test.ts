/** @vitest-environment jsdom */
import type { TagEntity as TagDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, fireEvent, getByRole, queryByRole, within } from "@testing-library/react";
import { TagsPane, TAG_COLOURS, tagHue, type TagsModel } from "../../../packages/app/src/settings/tags/index.js";
import { TextProvider } from "@ohmail/app/text";
import { tagDot } from "../../../packages/ui/src/base/Primitives/hue.js";
import messages from "../messages/en.json";
import { listSeat } from "../../../packages/app/test/places/list-seat.js";

/**
 * TAGS ARE EDITABLE — in Settings, and from the sidebar.
 *
 * Reported twice in one sentence: the sidebar should let you add tags, and Settings → Tags is
 * not implemented. Both were true and had one cause. `tag_assign`'s tag-or-create was the only
 * mint in the vocabulary, so a name needed a message to exist at all; and the pane's Rename and
 * Delete buttons both called `toast("Renaming and deleting tags isn't wired up yet.")` — two
 * controls whose only function was to say they had none, on a page where `POST /tags`,
 * `PATCH /tags/:id` and `DELETE /tags/:id` had been mounted and contract-tested the whole time.
 *
 * `packages/client-engine/test/tag-crud-wire.test.ts` proves the wire and the optimistic
 * effects. This file is about what only the rendered surface can be wrong about:
 *
 *  1. the dead sentence is GONE from the copy, so nothing can render it again;
 *  2. DELETE STATES THE COUNT BEFORE IT ASKS, and says the messages do not move;
 *  3. a shell that has not wired the verbs gets NO buttons rather than dead ones;
 *  4. the sidebar carries a create affordance that opens an input instead of navigating.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function tag(over: Partial<TagDTO> = {}): TagDTO {
  return {
    id: "t-1",
    name: "Invoices",
    hue: "moss",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root | null = null;

interface Dispatched {
  created: string[];
  renamed: Array<[string, string]>;
  recolored: Array<[string, string]>;
  deleted: string[];
}

async function renderSettings(opts: {
  tags: TagDTO[];
  counts?: Record<string, number>;
  wired?: boolean;
}): Promise<Dispatched> {
  const seen: Dispatched = { created: [], renamed: [], recolored: [], deleted: [] };
  const model: TagsModel = {
    tags: opts.tags.map(({ id, name, hue }) => ({
      id, name,
      colour: hue,
      hue: tagHue(hue),
      count: opts.counts?.[id] ?? 0,
    })),
    colours: TAG_COLOURS,
    newHue: tagHue("moss"),
    notOnServer: messages.tag.notOnServer,
    verbs: opts.wired === false ? null : {
      create: (name) => { seen.created.push(name); },
      rename: (id, name) => { seen.renamed.push([id, name]); },
      recolour: (id, hue) => { seen.recolored.push([id, hue]); },
      remove: (id) => { seen.deleted.push(id); },
    },
  };
  await act(async () => {
    root!.render(h(TextProvider, {
      locale: "en",
      messages,
      timeZone: "UTC",
      children: h(TagsPane, { model }),
    }));
  });
  return seen;
}

const button = (name: string) => getByRole<HTMLButtonElement>(host, "button", { name });
const field = (name: string) => getByRole<HTMLInputElement>(host, "textbox", { name });
const colours = () => getByRole(host, "menu", { name: "Colour for Invoices" });
const swatches = () => within(colours()).getAllByRole("menuitemradio");
const dialog = () => getByRole(host, "dialog");
const tint = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[aria-hidden]")?.style.getPropertyValue("--oh-hue-dot");

const clickText = (label: string) => fireEvent.click(button(label));

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => { fireEvent.change(input, { target: { value: text } }); });
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  cleanup();
  host.remove();
});

describe("the sentence that said it was not wired up is gone", () => {
  it("neither the key nor the sentence survives in the copy", () => {
    // A claim is a contract: it was false the moment the verbs landed, and the key surviving
    // in `en.json` is how it comes back. Matched exactly, for the reason
    // `attachments-wired.test.ts` gives about its own pair.
    const copy = read("../messages/en.json");
    expect(copy).not.toContain('"toastTagEditing"');
    expect(copy).not.toContain("Renaming and deleting tags isn't wired up yet.");
  });
});

describe("Settings → Tags: rename and delete", () => {
  it("lists each tag with how many messages carry it", async () => {
    await renderSettings({ tags: [tag()], counts: { "t-1": 12 } });
    expect(host.textContent).toContain("Invoices");
    expect(host.textContent).toContain("12 messages");
  });

  it("renaming dispatches the new name, and Cancel dispatches nothing", async () => {
    const seen = await renderSettings({ tags: [tag()], counts: { "t-1": 3 } });

    await act(async () => { clickText("Rename"); });
    const input = field("Rename");
    expect(input, "renaming replaces the row with a field").not.toBeNull();
    expect(input!.value, "the field starts from the current name").toBe("Invoices");

    await typeInto(input!, "Bills");
    await act(async () => { clickText("Save"); });
    expect(seen.renamed).toEqual([["t-1", "Bills"]]);

    // …and a rename that is abandoned writes nothing.
    await act(async () => { clickText("Rename"); });
    await act(async () => { clickText("Cancel"); });
    expect(seen.renamed).toHaveLength(1);
  });

  it("a rename to the same name, or to nothing, cannot be saved", async () => {
    // A Save that does nothing is a control that lies about having acted. The server would
    // accept the no-op PATCH quite happily, which is exactly why the guard is here.
    await renderSettings({ tags: [tag()] });
    await act(async () => { clickText("Rename"); });
    const save = () => button("Save");
    expect(save().disabled, "unchanged is not a rename").toBe(true);

    const input = field("Rename")!;
    await typeInto(input, "   ");
    expect(save().disabled, "empty is not a rename").toBe(true);
  });

  it("THE ONE THAT MATTERS: delete states the count and what survives BEFORE it asks", async () => {
    // "Delete Invoices?" with no number is a question nobody can answer. And the sentence
    // about the messages not moving has to be on screen BEFORE the mutation — a disclosure
    // that arrives afterwards is a notification. Same standard as the rules pane's revoke.
    const seen = await renderSettings({ tags: [tag()], counts: { "t-1": 12 } });

    await act(async () => { clickText("Delete"); });
    expect(seen.deleted, "the first press must not delete anything").toEqual([]);
    expect(host.textContent).toContain("Delete “Invoices”?");
    expect(host.textContent).toContain("It's on 12 of your messages.");
    expect(host.textContent).toContain("The messages stay where they are.");

    await act(async () => { fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" })); });
    expect(seen.deleted).toEqual(["t-1"]);
  });

  it("a tag on nothing says so rather than printing a zero", async () => {
    await renderSettings({ tags: [tag()], counts: {} });
    await act(async () => { clickText("Delete"); });
    expect(host.textContent).toContain("Nothing carries it.");
  });

  it("the pane says a tag is ohmail's row and not a folder in the mailbox", async () => {
    // Said once, where the verbs are: it is the one thing on this screen that does not live
    // in the user's own mailbox, and somebody about to build a taxonomy is owed that first.
    // The wording is `tag.notOnServer` verbatim — the picker already says it, and two copies
    // of a claim about what survives leaving is how one of them ends up false.
    await renderSettings({ tags: [tag()] });
    expect(host.textContent).toContain(messages.tag.notOnServer);
  });

  it("a shell that has not wired the verbs renders NO buttons, not dead ones", async () => {
    await renderSettings({ tags: [tag()], wired: false });
    expect(queryByRole(host, "button", { name: "Rename" })).toBeNull();
    expect(queryByRole(host, "button", { name: "Delete" })).toBeNull();
    expect(queryByRole(host, "button", { name: "Recolour Invoices" })).toBeNull();
    expect(queryByRole(host, "textbox", { name: "New tag" })).toBeNull();
    expect(queryByRole(host, "button", { name: "Add" })).toBeNull();
    // The list itself is still there — absence of verbs is not absence of tags.
    expect(host.textContent).toContain("Invoices");
  });
});

describe("Settings → Tags: recolour", () => {
  it("clicking the dot opens the renderable swatches and picking one dispatches the hue", async () => {
    const seen = await renderSettings({ tags: [tag({ hue: "moss" })], counts: { "t-1": 4 } });

    // The dot IS the recolour affordance — a button, so the keyboard reaches it too.
    const dot = button("Recolour Invoices");
    expect(dot, "the coloured dot opens the picker").not.toBeNull();
    await act(async () => { dot!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // Exactly the hues the Blanc system paints — no invisible-dot options, and no hue the
    // system paints that the picker forgets to offer. Derived from the pane’s palette rather than a
    // number, so growing the palette cannot leave this assertion describing the old one; the
    // floor underneath it is what stops the derivation from passing over an empty list.
    const entries = swatches();
    expect(TAG_COLOURS.length, "the palette is meant to carry a heavy tagger").toBeGreaterThanOrEqual(10);
    expect(entries).toHaveLength(TAG_COLOURS.length);
    const rosewood = within(colours()).getByRole("menuitemradio", { name: "Rosewood" });
    expect(rosewood, "rosewood is on the palette").toBeTruthy();

    await act(async () => { rosewood.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(seen.recolored).toEqual([["t-1", "rosewood"]]);
  });

  it("every swatch is named for a screen reader, and no two share a name", () => {
    // The swatch's whole accessible content is its `aria-label` — the dot inside it is a bare
    // <span>. A hue whose catalogue key is missing renders the KEY, which reads aloud as
    // "settings dot hue underscore iris", and two hues sharing a label are two controls a
    // keyboard user cannot tell apart.
    // `settings` is not a flat string map — `languageName` is a nested { en, de } — so the lookup
    // is typed as `unknown` and narrowed, rather than cast to something the catalogue is not.
    const settings: Record<string, unknown> = messages.settings;
    const labels = TAG_COLOURS.map(({ id }) => settings[`hue_${id}`]);
    for (const [i, label] of labels.entries()) {
      expect(typeof label, `settings.hue_${TAG_COLOURS[i]?.id} is missing from en.json`).toBe("string");
      expect(label as string, `settings.hue_${TAG_COLOURS[i]?.id} rendered as its own key`)
        .not.toContain("hue_");
    }
    expect(new Set(labels).size, "two swatches share an accessible name").toBe(labels.length);
  });

  it("a hue added since the palette grew is selectable and dispatches its own name", async () => {
    // The widening is only real if a NEW hue survives the trip from swatch to mutation. Picked
    // by its accessible name, the way a user reaches it, rather than by index — an off-by-one
    // over a reordered palette would otherwise dispatch a colour nobody clicked.
    const seen = await renderSettings({ tags: [tag({ hue: "moss" })] });
    await act(async () => {
      button("Recolour Invoices")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const iris = within(colours()).getByRole("menuitemradio", { name: "Iris" });
    expect(iris, "iris is on the palette").toBeTruthy();
    await act(async () => { iris!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(seen.recolored).toEqual([["t-1", "iris"]]);
  });

  it("a tag already carrying a new hue renders in it rather than falling back to moss", async () => {
    // The read half of the round trip: `hueOf` clamps anything it cannot paint to moss, so a
    // stored `mulberry` that had not reached the palette would render — silently — as green.
    await renderSettings({ tags: [tag({ hue: "mulberry" })] });
    // Scoped to the row's own dot: the pane's create row carries a static moss dot of its own,
    // so a bare `.tdot.hue-moss` query over the host is always non-null and would assert nothing.
    expect(tint(button("Recolour Invoices")), "the row's dot is painted mulberry, not clamped to moss")
      .toBe(tagDot(320));

    await act(async () => { clickText("Recolour Invoices"); });
    expect(within(colours()).getByRole("menuitemradio", { name: "Mulberry", checked: true })).toBeTruthy();
  });

  it("a hue this build cannot paint still falls back to moss", async () => {
    // The set the server used to accept alone (`clay|slate|plum|amber|teal`) is still in the
    // database. Widening the palette must not start rendering those; they clamp, as before.
    await renderSettings({ tags: [tag({ hue: "amber" })] });
    expect(tint(button("Recolour Invoices")), "an unpaintable hue clamps to moss").toBe(tagDot(150));
    await act(async () => { clickText("Recolour Invoices"); });
    expect(within(colours()).queryByRole("menuitemradio", { name: "Amber" })).toBeNull();
  });

  it("the current hue is marked, and Cancel dispatches nothing", async () => {
    const seen = await renderSettings({ tags: [tag({ hue: "ochre" })] });
    await act(async () => {
      button("Recolour Invoices")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const current = within(colours()).getByRole("menuitemradio", { name: "Ochre", checked: true });
    expect(current, "the current hue is the checked one").toBeTruthy();

    await act(async () => { fireEvent.keyDown(current, { key: "Escape" }); });
    expect(queryByRole(host, "menu", { name: "Colour for Invoices" })).toBeNull();
    expect(seen.recolored).toEqual([]);
  });
});

describe("Settings → Tags: create, inline in the pane", () => {
  it("typing a name and pressing Add dispatches the create", async () => {
    const seen = await renderSettings({ tags: [tag()] });
    const input = field("New tag");
    expect(input, "the pane carries a create field").not.toBeNull();
    await typeInto(input!, "Travel");
    await act(async () => { clickText("Add"); });
    expect(seen.created).toEqual(["Travel"]);
  });

  it("a duplicate name is refused case-insensitively, with the reason on screen and Add disabled", async () => {
    const seen = await renderSettings({ tags: [tag({ name: "Invoices" })] });
    const input = field("New tag")!;
    await typeInto(input, "invoices");   // case-flipped — the server's unique index is on lower(name)
    const add = () => button("Add");
    expect(add().disabled, "a duplicate cannot be added").toBe(true);
    expect(host.textContent).toContain("You already have a tag called");
    await act(async () => { add().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(seen.created).toEqual([]);
  });
});

describe("the sidebar can make a tag — inline, no dialog", () => {
  const railSource = () => read("../../../packages/app/src/tags/TagsRail.tsx");

  it("the rail hands RailNav an inline create config, not a nav row into a dialog", () => {
    const rail = railSource();
    expect(rail).toMatch(/onPress=\{\(\) => setEditing\(true\)\}[\s\S]*?<RailField/);
    expect(rail).not.toMatch(/TAG_CREATE_ROW_ID/);
    expect(rail).not.toMatch(/setTagCreateOpen|<Dialog/);
    expect(
      existsSync(resolve(process.cwd(), "apps/webapp/app/shell/TagCreate.tsx")),
      "the TagCreate modal must be deleted, not merely unreferenced",
    ).toBe(false);
  });

  it("creating from the sidebar is the standalone verb, with no message involved", () => {
    const block = railSource().split("onCommit={(name) => {")[1]?.split("}}")[0] ?? "";
    expect(block).toMatch(/kind: "tag_create"/);
    expect(block).not.toMatch(/messageId/);
  });

  it("the input keeps Escape to itself, so the shell's overlay ladder cannot also act on it", () => {
    const rail = read("../../../packages/ui/src/mail/Shell/RailField.tsx");
    const escape = rail.slice(rail.indexOf('event.key === "Escape"'), rail.indexOf("  const style"));
    expect(escape).toMatch(/event\.key === "Escape"[\s\S]*?event\.stopPropagation\(\)/);
  });

  it("the delete toast names the tag, which means reading it BEFORE the mutation", () => {
    const verbs = read("../../../packages/app-logic/src/press/tag-verbs.ts");
    const block = verbs.slice(verbs.indexOf("export function deleteTag"));
    const dispatch = block.indexOf("cx.press.mutateAndReport(");
    const name = block.indexOf("const name = cx.tags.find(");
    expect(dispatch, "no dispatch in deleteTag").toBeGreaterThanOrEqual(0);
    expect(name, "the tag's name is not read").toBeGreaterThanOrEqual(0);
    expect(name).toBeLessThan(dispatch);
    expect(block.slice(dispatch)).toContain('cx.t("tag.toastDeleted", { name })');
  });
});

describe("the rail's inline tag create — what only the rendered rail can be wrong about", () => {
  const rail = () => getByRole(document.body, "navigation", { name: "Places" });
  const trigger = () => within(rail()).queryByRole<HTMLButtonElement>("button", { name: "New tag" });
  const railInput = () => within(rail()).queryByRole<HTMLInputElement>("textbox", { name: "New tag" });
  const renderRail = (tagNames: string[]) => {
    const more = Object.fromEntries(tagNames.map((name, i) => {
      const entity = tag({ id: `t-${i}`, name });
      return [`tag:${entity.id}`, entity];
    }));
    const { mail } = listSeat({ letters: [], more, first: "#/ohbox" });
    fireEvent.click(within(rail()).getByRole("button", { name: "Tags", expanded: false }));
    return mail;
  };

  it("offers a `+ New tag` trigger — an action, not a tag: no dot, no count, and no dialog", async () => {
    renderRail(["Invoices"]);
    const t = trigger();
    expect(t, "the rail carries a create affordance").toBeTruthy();
    expect(t!.getAttribute("aria-current")).toBeNull();
    // A `+` where a tag's dot would be, and no count — a verb is not a place.
    expect(t!.querySelector("svg")).not.toBeNull();
    expect(t!.style.getPropertyValue("--oh-railentry-dot")).toBe("");
    expect(t!.textContent).toBe("New tag");
    expect(rail().ownerDocument.querySelector("[aria-modal]"), "no modal — the whole point").toBeNull();
  });

  it("opens an input IN PLACE and Enter mints the typed name", async () => {
    const mail = renderRail(["Invoices"]);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = railInput();
    expect(input, "the trigger becomes a field").not.toBeNull();
    await typeInto(input!, "Bills");
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(mail.mutations).toEqual([{ kind: "tag_create", tagId: expect.any(String), name: "Bills" }]);
    expect(rail().ownerDocument.querySelector("[aria-modal]"), "inline the whole time").toBeNull();
  });

  it("Escape abandons the input and mints nothing", async () => {
    const mail = renderRail(["Invoices"]);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = railInput()!;
    await typeInto(input, "Bills");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(railInput()).toBeNull();
    expect(mail.mutations).toEqual([]);
  });

  it("an assistive tool's focus on the open field keeps it: the same node, focused, an ordinary named entry", async () => {
    // WebKitGTK answers AT-SPI grab_focus on an already-focused field with a blur
    // and a focus inside one call; the field used to unmount on that blur and the desktop's web
    // process died with it.
    renderRail(["Invoices"]);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = railInput()!;
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe("text");
    expect(input.getAttribute("role")).toBeNull();
    expect(input.getAttribute("aria-label")).toBe("New tag");
    expect(input.closest("[aria-live],[role=alert],[role=status]")).toBeNull();
    await act(async () => { input.blur(); input.focus(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(railInput()).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("focus leaving the empty field still closes it, one task after the blur and not inside it", async () => {
    renderRail(["Invoices"]);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = railInput()!;
    // A synchronous act, read in the same task: it flushes whatever the blur's own dispatch
    // set, and yields nothing, so the deferred check cannot have run yet. An awaited act
    // drains through setImmediate, and on a loaded runner the 1 ms timer fires first.
    void act(() => { input.blur(); });
    expect(railInput(), "unmounted inside the blur's dispatch").toBe(input);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(railInput()).toBeNull();
    expect(trigger(), "the trigger is back").toBeTruthy();
  });

  it("with no tags yet: an invite to the first, and the same trigger — never a blank group", async () => {
    renderRail([]);
    expect(rail().textContent).toContain("No tags yet.");
    expect(trigger(), "the empty state still offers the create affordance").toBeTruthy();
  });

  it("a name that already exists is refused — case-insensitive — with the reason on screen", async () => {
    const mail = renderRail(["Invoices"]);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = railInput()!;
    // Case-flipped, because the server's unique index is on `lower(name)`.
    await typeInto(input, "invoices");
    expect(rail().textContent).toContain("You already have a tag called");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(mail.mutations, "a duplicate cannot be minted").toEqual([]);
  });
});

/* "bulk tag-assign writes assignments only" > "the bulk-tag verb fans out tag_assign and never promotes a rule" MOVED
   word for word (share ohbox-2) to `bulk-tag-writes-assignments-only.test.ts`, re-pointed by path to where the verb
   lives now (`packages/app-logic/src/press/tag-verbs.ts`). */
