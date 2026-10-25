/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { RailNav, TAG_HUES, ThemeProvider, ToastHost } from "@ohmail/ui";
import type { TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { shellFrameOf } from "./source-anchor";

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
  const view = h(SettingsView, {
    notifications: null,
    tags: opts.tags,
    tagCounts: opts.counts ?? {},
    ...(opts.wired === false
      ? {}
      : {
          tagAdmin: {
            onCreate: (name: string) => { seen.created.push(name); },
            onRename: (id: string, name: string) => { seen.renamed.push([id, name]); },
            onRecolor: (id: string, hue: string) => { seen.recolored.push([id, hue]); },
            onDelete: (id: string) => { seen.deleted.push(id); },
          },
        }),
  });
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-04T12:00:00.000Z"),
        children: h(ThemeProvider, { children: h(ToastHost, { children: view }) }),
      }),
    );
  });
  return seen;
}

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>("button")];

function clickText(label: string): void {
  const btn = buttons().find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`no button "${label}" — have: ${buttons().map((b) => b.textContent).join(" | ")}`);
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

const openTags = async (): Promise<void> => { await act(async () => { clickText("Tags"); }); };

/** Type into an input the way React wants to hear about it — a bare `.value =` is invisible. */
async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
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
    await openTags();
    expect(host.textContent).toContain("Invoices");
    expect(host.textContent).toContain("12 messages");
  });

  it("renaming dispatches the new name, and Cancel dispatches nothing", async () => {
    const seen = await renderSettings({ tags: [tag()], counts: { "t-1": 3 } });
    await openTags();

    await act(async () => { clickText("Rename"); });
    const input = host.querySelector<HTMLInputElement>(".set-tag-input");
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
    await openTags();
    await act(async () => { clickText("Rename"); });
    const save = () => buttons().find((b) => b.textContent?.trim() === "Save")!;
    expect(save().disabled, "unchanged is not a rename").toBe(true);

    const input = host.querySelector<HTMLInputElement>(".set-tag-input")!;
    await typeInto(input, "   ");
    expect(save().disabled, "empty is not a rename").toBe(true);
  });

  it("THE ONE THAT MATTERS: delete states the count and what survives BEFORE it asks", async () => {
    // "Delete Invoices?" with no number is a question nobody can answer. And the sentence
    // about the messages not moving has to be on screen BEFORE the mutation — a disclosure
    // that arrives afterwards is a notification. Same standard as the rules pane's revoke.
    const seen = await renderSettings({ tags: [tag()], counts: { "t-1": 12 } });
    await openTags();

    await act(async () => { clickText("Delete"); });
    expect(seen.deleted, "the first press must not delete anything").toEqual([]);
    expect(host.textContent).toContain("Delete “Invoices”?");
    expect(host.textContent).toContain("It's on 12 of your messages.");
    expect(host.textContent).toContain("The messages stay where they are.");

    await act(async () => { clickText("Delete"); });
    expect(seen.deleted).toEqual(["t-1"]);
  });

  it("a tag on nothing says so rather than printing a zero", async () => {
    await renderSettings({ tags: [tag()], counts: {} });
    await openTags();
    await act(async () => { clickText("Delete"); });
    expect(host.textContent).toContain("Nothing carries it.");
  });

  it("the pane says a tag is ohmail's row and not a folder in the mailbox", async () => {
    // Said once, where the verbs are: it is the one thing on this screen that does not live
    // in the user's own mailbox, and somebody about to build a taxonomy is owed that first.
    // The wording is `tag.notOnServer` verbatim — the picker already says it, and two copies
    // of a claim about what survives leaving is how one of them ends up false.
    await renderSettings({ tags: [tag()] });
    await openTags();
    expect(host.textContent).toContain(messages.tag.notOnServer);
  });

  it("a shell that has not wired the verbs renders NO buttons, not dead ones", async () => {
    await renderSettings({ tags: [tag()], wired: false });
    await openTags();
    const labels = buttons().map((b) => b.textContent?.trim());
    expect(labels).not.toContain("Rename");
    expect(labels).not.toContain("Delete");
    // The recolour dot-button and the create row are verbs too — gone with the rest.
    expect(host.querySelector(".set-tag-dot")).toBeNull();
    expect(host.querySelector(".set-tag-new")).toBeNull();
    // The list itself is still there — absence of verbs is not absence of tags.
    expect(host.textContent).toContain("Invoices");
  });
});

describe("Settings → Tags: recolour", () => {
  it("clicking the dot opens the renderable swatches and picking one dispatches the hue", async () => {
    const seen = await renderSettings({ tags: [tag({ hue: "moss" })], counts: { "t-1": 4 } });
    await openTags();

    // The dot IS the recolour affordance — a button, so the keyboard reaches it too.
    const dot = host.querySelector<HTMLButtonElement>(".set-tag-dot");
    expect(dot, "the coloured dot opens the picker").not.toBeNull();
    await act(async () => { dot!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // Exactly the hues the Blanc system paints — no invisible-dot options, and no hue the
    // system paints that the picker forgets to offer. Derived from TAG_HUES rather than a
    // number, so growing the palette cannot leave this assertion describing the old one; the
    // floor underneath it is what stops the derivation from passing over an empty list.
    const swatches = [...host.querySelectorAll<HTMLButtonElement>(".set-hue")];
    expect(TAG_HUES.length, "the palette is meant to carry a heavy tagger").toBeGreaterThanOrEqual(10);
    expect(swatches).toHaveLength(TAG_HUES.length);
    const rosewood = swatches.find((b) => b.getAttribute("aria-label") === "Rosewood")!;
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
    const labels = TAG_HUES.map((h) => settings[`hue_${h}`]);
    for (const [i, label] of labels.entries()) {
      expect(typeof label, `settings.hue_${TAG_HUES[i]} is missing from en.json`).toBe("string");
      expect(label as string, `settings.hue_${TAG_HUES[i]} rendered as its own key`)
        .not.toContain("hue_");
    }
    expect(new Set(labels).size, "two swatches share an accessible name").toBe(labels.length);
  });

  it("a hue added since the palette grew is selectable and dispatches its own name", async () => {
    // The widening is only real if a NEW hue survives the trip from swatch to mutation. Picked
    // by its accessible name, the way a user reaches it, rather than by index — an off-by-one
    // over a reordered palette would otherwise dispatch a colour nobody clicked.
    const seen = await renderSettings({ tags: [tag({ hue: "moss" })] });
    await openTags();
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".set-tag-dot")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const iris = [...host.querySelectorAll<HTMLButtonElement>(".set-hue")]
      .find((b) => b.getAttribute("aria-label") === "Iris");
    expect(iris, "iris is on the palette").toBeTruthy();
    await act(async () => { iris!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(seen.recolored).toEqual([["t-1", "iris"]]);
  });

  it("a tag already carrying a new hue renders in it rather than falling back to moss", async () => {
    // The read half of the round trip: `hueOf` clamps anything it cannot paint to moss, so a
    // stored `mulberry` that had not reached `TAG_HUES` would render — silently — as green.
    await renderSettings({ tags: [tag({ hue: "mulberry" })] });
    await openTags();
    // Scoped to the row's own dot: the pane's create row carries a static moss dot of its own,
    // so a bare `.tdot.hue-moss` query over the host is always non-null and would assert nothing.
    const rowDot = host.querySelector(".set-tag-dot .tdot");
    expect(rowDot?.className, "the row's dot is painted mulberry, not clamped to moss")
      .toBe("tdot hue-mulberry");

    await act(async () => {
      host.querySelector<HTMLButtonElement>(".set-tag-dot")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const current = [...host.querySelectorAll<HTMLButtonElement>(".set-hue")]
      .find((b) => b.getAttribute("aria-pressed") === "true");
    expect(current?.getAttribute("aria-label")).toBe("Mulberry");
  });

  it("a hue this build cannot paint still falls back to moss", async () => {
    // The set the server used to accept alone (`clay|slate|plum|amber|teal`) is still in the
    // database. Widening the palette must not start rendering those; they clamp, as before.
    await renderSettings({ tags: [tag({ hue: "amber" })] });
    await openTags();
    expect(host.querySelector(".set-tag-dot .tdot")?.className, "an unpaintable hue clamps to moss")
      .toBe("tdot hue-moss");
    expect(host.querySelector(".tdot.hue-amber")).toBeNull();
  });

  it("the current hue is marked, and Cancel dispatches nothing", async () => {
    const seen = await renderSettings({ tags: [tag({ hue: "ochre" })] });
    await openTags();
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".set-tag-dot")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const current = [...host.querySelectorAll<HTMLButtonElement>(".set-hue")]
      .find((b) => b.getAttribute("aria-pressed") === "true");
    expect(current?.getAttribute("aria-label"), "the current hue is the pressed one").toBe("Ochre");

    clickText("Cancel");
    expect(seen.recolored).toEqual([]);
  });
});

describe("Settings → Tags: create, inline in the pane", () => {
  it("typing a name and pressing Add dispatches the create", async () => {
    const seen = await renderSettings({ tags: [tag()] });
    await openTags();
    const input = host.querySelector<HTMLInputElement>(".set-tag-new .set-tag-input");
    expect(input, "the pane carries a create field").not.toBeNull();
    await typeInto(input!, "Travel");
    await act(async () => { clickText("Add"); });
    expect(seen.created).toEqual(["Travel"]);
  });

  it("a duplicate name is refused case-insensitively, with the reason on screen and Add disabled", async () => {
    const seen = await renderSettings({ tags: [tag({ name: "Invoices" })] });
    await openTags();
    const input = host.querySelector<HTMLInputElement>(".set-tag-new .set-tag-input")!;
    await typeInto(input, "invoices");   // case-flipped — the server's unique index is on lower(name)
    const add = () => buttons().find((b) => b.textContent?.trim() === "Add")!;
    expect(add().disabled, "a duplicate cannot be added").toBe(true);
    expect(host.textContent).toContain("You already have a tag called");
    await act(async () => { add().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(seen.created).toEqual([]);
  });
});

describe("the sidebar can make a tag — inline, no dialog", () => {
  /* The rail left `AppShell.tsx` for `shell-keys.tsx` with the palette and the global chords
     (ARCH-022 L6); the verb it names is still `shell-verbs.ts`'s, asked by `shellFrameOf` below. */
  const shell = shellFrameOf("railGroupsWithHints").source;

  it("the rail hands RailNav an inline create config, not a nav row into a dialog", () => {
    // The rejected shape opened a centred modal from a sentinel rail id (`TAG_CREATE_ROW_ID`,
    // routed to `setTagCreateOpen`). Creating a tag is inline now: the rail passes a `create`
    // config whose verb is the standalone `createTagAlone`, and there is neither a modal to open
    // nor a sentinel to intercept before `goTag`.
    expect(shell).toMatch(/create: \{[\s\S]*?onCreate: createTagAlone/);
    expect(shell).not.toMatch(/TAG_CREATE_ROW_ID/);
    expect(shell).not.toMatch(/setTagCreateOpen/);
    // The modal component is gone from the tree entirely, so nothing can render it again.
    // Resolved from the repo root (the suite's cwd), because `import.meta.url` is not a file
    // URL under vitest — the same reason `touch-key-hints.test.ts` reaches for `process.cwd()`.
    expect(
      existsSync(resolve(process.cwd(), "apps/webapp/app/shell/TagCreate.tsx")),
      "the TagCreate modal must be deleted, not merely unreferenced",
    ).toBe(false);
  });

  it("creating from the sidebar is the standalone verb, with no message involved", () => {
    // `tag_assign` + `createName` needs a message to put the tag on, which is precisely the
    // thing the sidebar does not have. If this ever regresses to tag-or-create, the sidebar
    // silently stops being able to make a tag that is on nothing.
    /* THE FRAME THAT DECLARES IT: the tag verbs left `AppShell.tsx` for `shell-verbs.ts` at
       ARCH-022, and `shellFrameOf` refuses zero hits and two. The window inside the frame is
       the one this case has always used. */
    const verbs = shellFrameOf("createTagAlone").source;
    const block = verbs.slice(verbs.indexOf("const createTagAlone"), verbs.indexOf("const renameTag"));
    expect(block).toMatch(/kind: "tag_create"/);
    expect(block).not.toMatch(/messageId/);
  });

  it("the input keeps Escape to itself, so the shell's overlay ladder cannot also act on it", () => {
    // The modal used `stopPropagation` for the same reason (it was the innermost open thing);
    // the inline input is now that innermost thing, and its Escape must not reach the document
    // listener the keymap registers — otherwise closing the field would also close the reader
    // behind it. This is the precedence the removed escape-ladder entry used to carry.
    const rail = read("../../../packages/ui/src/composites/RailNav.tsx");
    // From the input onward — the rail rows above it also carry an `onBlur`, so anchoring the
    // slice end on that would fold the whole input block away. The input's is the only
    // `Escape` handler after `ritem-new-input`, and it stops the event.
    const inputOnward = rail.slice(rail.indexOf("ritem-new-input"));
    expect(inputOnward).toMatch(/e\.key === "Escape"[\s\S]*?e\.stopPropagation\(\)/);
  });

  it("the delete toast names the tag, which means reading it BEFORE the mutation", () => {
    // The optimistic effect tombstones the row, so a read afterwards answers undefined and
    // the sentence would be about a tag it could not name.
    const verbs = shellFrameOf("deleteTag").source;
    const block = verbs.slice(verbs.indexOf("const deleteTag"), verbs.indexOf("const tagAdmin"));
    /* The DISPATCH, by either spelling: tag verbs go through the shell's `mutateAndReport` seam
       now (the sentence waits for the answer), and a needle on `engine.mutate` alone answered
       -1 and passed the comparison over nothing. */
    const dispatch = ["mutateAndReport(", "engine.mutate("]
      .map((spell) => block.indexOf(spell)).filter((at) => at >= 0);
    expect(dispatch, "no dispatch in `deleteTag` at all — this control matches nothing")
      .not.toEqual([]);
    expect(block.indexOf("reader.get")).toBeLessThan(Math.min(...dispatch));
  });
});

describe("the rail's inline tag create — what only the rendered rail can be wrong about", () => {
  /**
   * Mount the real `RailNav` with a Tags group and a create config, and drive it. This runs the
   * shipped component, so it tells "written" from "shipped" the way a source scan cannot — the
   * concern the old `git show HEAD` assertion was reaching for, met by running the code instead.
   * `sink` collects the names the host would mint; `taken` is the existing set the dup check
   * refuses against.
   */
  async function renderRail(tagNames: string[], sink: string[], taken: string[] = []): Promise<void> {
    await act(async () => {
      root!.render(
        h(RailNav, {
          composeLabel: "Compose",
          mailboxesLabel: "Mailboxes",
          ariaLabel: "Main",
          groups: [
            {
              items: [{ id: "ohbox", label: "Ohbox" }],
              tags: {
                label: "Tags",
                items: tagNames.map((name, i) => ({ id: `t-${i}`, label: name, hue: "moss" as const })),
                create: {
                  label: "New tag",
                  placeholder: "Name it…",
                  emptyHint: "No tags yet.",
                  onCreate: (name: string) => { sink.push(name); },
                  duplicate: {
                    taken: (name: string) => taken.some((x) => x.toLowerCase() === name.toLowerCase()),
                    label: (name: string) => `You already have a tag called “${name}”.`,
                  },
                },
              },
            },
          ],
        }),
      );
    });
  }

  const trigger = (): HTMLButtonElement | undefined =>
    buttons().find((b) => b.textContent?.trim() === "New tag");

  it("offers a `+ New tag` trigger — an action, not a tag: no dot, no count, and no dialog", async () => {
    await renderRail(["Invoices"], []);
    const t = trigger();
    expect(t, "the rail carries a create affordance").toBeTruthy();
    expect(t!.classList.contains("ritem-action")).toBe(true);
    // A `+` where a tag's dot would be, and no count — a verb is not a place.
    expect(t!.querySelector(".ritem-plus")).not.toBeNull();
    expect(t!.querySelector(".cnt")).toBeNull();
    expect(host.querySelector("[aria-modal]"), "no modal — the whole point").toBeNull();
  });

  it("opens an input IN PLACE and Enter mints the typed name", async () => {
    const sink: string[] = [];
    await renderRail(["Invoices"], sink);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = host.querySelector<HTMLInputElement>(".ritem-new-input");
    expect(input, "the trigger becomes a field").not.toBeNull();
    await typeInto(input!, "Bills");
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(sink).toEqual(["Bills"]);
    expect(host.querySelector("[aria-modal]"), "inline the whole time").toBeNull();
  });

  it("Escape abandons the input and mints nothing", async () => {
    const sink: string[] = [];
    await renderRail(["Invoices"], sink);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = host.querySelector<HTMLInputElement>(".ritem-new-input")!;
    await typeInto(input, "Bills");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector(".ritem-new-input")).toBeNull();
    expect(sink).toEqual([]);
  });

  it("an assistive tool's focus on the open field keeps it: the same node, focused, an ordinary named entry", async () => {
    // WebKitGTK answers AT-SPI grab_focus on an already-focused field with a blur
    // and a focus inside one call; the field used to unmount on that blur and the desktop's web
    // process died with it.
    await renderRail(["Invoices"], []);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = host.querySelector<HTMLInputElement>(".ritem-new-input")!;
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe("text");
    expect(input.getAttribute("role")).toBeNull();
    expect(input.getAttribute("aria-label")).toBe("New tag");
    expect(input.closest("[aria-live],[role=alert],[role=status]")).toBeNull();
    await act(async () => { input.blur(); input.focus(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(host.querySelector(".ritem-new-input")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("focus leaving the empty field still closes it, one task after the blur and not inside it", async () => {
    await renderRail(["Invoices"], []);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = host.querySelector<HTMLInputElement>(".ritem-new-input")!;
    // A synchronous act, read in the same task: it flushes whatever the blur's own dispatch
    // set, and yields nothing, so the deferred check cannot have run yet. An awaited act
    // drains through setImmediate, and on a loaded runner the 1 ms timer fires first.
    void act(() => { input.blur(); });
    expect(host.querySelector(".ritem-new-input"), "unmounted inside the blur's dispatch").toBe(input);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(host.querySelector(".ritem-new-input")).toBeNull();
    expect(trigger(), "the trigger is back").toBeTruthy();
  });

  it("with no tags yet: an invite to the first, and the same trigger — never a blank group", async () => {
    await renderRail([], []);
    expect(host.textContent).toContain("No tags yet.");
    expect(trigger(), "the empty state still offers the create affordance").toBeTruthy();
  });

  it("a name that already exists is refused — case-insensitive — with the reason on screen", async () => {
    const sink: string[] = [];
    await renderRail(["Invoices"], sink, ["Invoices"]);
    await act(async () => { trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const input = host.querySelector<HTMLInputElement>(".ritem-new-input")!;
    // Case-flipped, because the server's unique index is on `lower(name)`.
    await typeInto(input, "invoices");
    expect(host.textContent).toContain("You already have a tag called");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(sink, "a duplicate cannot be minted").toEqual([]);
  });
});

describe("bulk tag-assign writes assignments only", () => {
  it("the bulk-tag verb fans out tag_assign and never promotes a rule", () => {
    // A bulk tag over a selection is `bulkToggleTag` — the whole path. It must dispatch
    // `tag_assign` per message and nothing that writes a rule: "always tag this sender" is an
    // explicit rule the user makes, never inferred from a bulk act. Same standard
    // `planBulkScreening` states when it passes `makeRule: false`. Read from the function body so
    // an added rule/decide dispatch inside it trips this. The mutation-level proof is in
    // `packages/client-engine/test/tag-crud-wire.test.ts`; this pins the shell caller too.
    const verbs = shellFrameOf("bulkToggleTag").source;
    const block = verbs.slice(verbs.indexOf("const bulkToggleTag"), verbs.indexOf("const createTag ="));
    expect(block).toMatch(/kind: "tag_assign"/);
    expect(block).not.toMatch(/kind: "rule_create"/);
    expect(block).not.toMatch(/kind: "screener_decide"/);
  });
});
