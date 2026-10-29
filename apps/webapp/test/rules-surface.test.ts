/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { MemoryMirrorStore, rulesList } from "@ohmail/client-engine";
import type { Folder, MutationStatus, RuleDTO, SyncChange } from "@ohmail/client-engine";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";
import baseMessages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { filterRules, groupByDestination, ruleDate } from "../app/views/RulesView";
import { setActiveFormatZone } from "../app/shell/locale";

/**
 * THE RULES SURFACE, AS A USER MEETS IT.
 *
 * `packages/client-engine/test/rules.test.ts` proves the wire and the mirror. This file is
 * about the three things only the rendered surface can be wrong about:
 *
 *  1. the pane EXISTS and lists what the rule actually is (who, where, when, where from);
 *  2. revoking is TWO steps and the "your mail does not move" sentence is on screen BEFORE
 *     the mutation is dispatched, not after — a disclosure that arrives afterwards is a
 *     notification;
 *  3. nothing claims a message count. `RuleDTO.stats.hits` is never written by anything in
 *     the repository, so a number there would be a lie about a rule that has filed thousands.
 *
 * It also covers the management surface the flat list grew into — search, destination facets, a
 * windowed list and a bulk revoke that acts over the FILTERED set through the same per-rule path.
 *
 * ── ABOUT THE COPY IN THIS FILE ─────────────────────────────────────────────────────────
 *
 * The `rules` namespace and `settings.rules` now live in `en.json`, so the assertions read the
 * shipping copy directly — a change to a sentence here breaks the test that names it, which is
 * the point. There is no local override to drift from the file any more.
 */
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages = baseMessages;

function rule(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: "r-1",
    kind: "sender",
    match: "lena@atelier-eichspan.example",
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root | null = null;

interface Dispatched {
  revoked: string[];
  retargeted: Array<[string, Folder, boolean | "walk"]>;
}

async function renderSettings(
  rules: { items: RuleDTO[]; status?: MutationStatus; more?: Record<string, unknown> } | undefined,
): Promise<Dispatched> {
  const seen: Dispatched = { revoked: [], retargeted: [] };
  const status: MutationStatus = rules?.status ?? "confirmed";
  const view = h(SettingsView, {
    notifications: null,
    tags: [],
    tagCounts: {},
    ...(rules
      ? {
          rules: {
            items: rules.items,
            onRevoke: async (id: string) => {
              seen.revoked.push(id);
              return { status };
            },
            onRetarget: async (id: string, dest: Folder, applyRetro: boolean | "walk") => {
              seen.retargeted.push([id, dest, applyRetro]);
              return { status };
            },
            pastMail: () => 0,
            ...rules.more,
          },
        }
      : {}),
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

/** Every clickable control's visible text, in DOM order. */
function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button")];
}

function clickText(label: string): void {
  const btn = buttons().find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`no button labelled "${label}" — have: ${buttons().map((b) => b.textContent).join(" | ")}`);
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function openRulesPane(): Promise<void> {
  await act(async () => {
    clickText("Rules");
  });
}

/** The rule rows currently MOUNTED — each carries `data-rule-id`; the window's spacers do not. */
function ruleRows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-rule-id]")];
}

/**
 * Drive the search box the way a keystroke does. The native `value` setter is used deliberately:
 * React patches the instance setter to track its own last value, so `input.value = x` leaves the
 * tracked value equal to the new one and `onChange` never fires. Going through the prototype
 * setter changes the DOM value without touching React's tracker, so the `input` event reads as a
 * real change — the same trick React Testing Library uses.
 */
async function typeSearch(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("no search box on the pane");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host.remove();
});

describe("the pane exists and says what the rule is", () => {
  it("lists the sender, where it files, when it was made and where it came from", async () => {
    await renderSettings({ items: [rule()] });
    await openRulesPane();

    const text = host.textContent ?? "";
    expect(text).toContain("Mail from lena@atelier-eichspan.example");
    expect(text).toContain("Files into Ohbox");
    expect(text).toContain("from a Screener decision");
    expect(text).toContain("1 Aug 2026");
  });

  it("says 'anyone at' for a domain rule — a domain is a different promise from an address", async () => {
    await renderSettings({ items: [rule({ kind: "domain", match: "lichtgrat.de" })] });
    await openRulesPane();
    expect(host.textContent).toContain("Mail from anyone at lichtgrat.de");
    expect(host.textContent).not.toContain("Mail from lichtgrat.de·");
  });

  it("distinguishes a rule the user made from one a Screener decision made", async () => {
    await renderSettings({
      items: [rule({ id: "a", provenance: "manual" }), rule({ id: "b", match: "x@y.z" })],
    });
    await openRulesPane();
    expect(host.textContent).toContain("you made this one");
    expect(host.textContent).toContain("from a Screener decision");
  });

  it("says a paused rule sorts nothing, rather than showing it like a live one", async () => {
    await renderSettings({ items: [rule({ enabled: false })] });
    await openRulesPane();
    expect(host.textContent).toContain("paused, so it sorts nothing");
  });

  /**
   * THE COUNT THAT MUST NOT APPEAR. `hits`, `lastHitAt` and `demotions` are declared in the
   * schema, faithfully materialized into `RuleDTO.stats`, and written by NOTHING — so a rule
   * that has filed thousands of messages carries `hits: 0`. Rendering it would be the
   * page's one outright lie, and it is the cheapest possible mistake to make.
   */
  it("claims no message count anywhere", async () => {
    await renderSettings({ items: [rule({ stats: { hits: 0, lastHitAt: null, demotions: 0 } })] });
    await openRulesPane();
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/\b0 messages\b/);
    expect(text).not.toMatch(/\bmessages? filed\b/);
    expect(text).toContain("Nothing records how many messages a rule has filed");
  });

  it("an account with no rules says so, and still says the count is not recorded", async () => {
    await renderSettings({ items: [] });
    await openRulesPane();
    expect(host.textContent).toContain("No rules yet.");
  });
});

/**
 * A REAL ROW OFF THE PRODUCTION API, PASTED VERBATIM.
 *
 * Fetched 2026-08-04 from `GET https://api.ohmail.app/rules`, signed in as a test account
 * (never a person's own). It is the whole point of pinning it: every
 * fixture in this file was written by the same hand that wrote the component, so a field the
 * server actually sends in a different shape would be invisible to all of them. Note `stats`
 * — `hits: 0` on a rule that has been live since 3 August, which is the dead-counter finding
 * as the production database reports it, not as the schema promises it.
 */
const PRODUCTION_RULE: RuleDTO = {
  id: "db20a01d-7f59-465e-be48-2084ddfa137b",
  kind: "sender",
  match: "contact.442@quietharbor.invalid",
  destination: "INBOX",
  priority: 0,
  provenance: "promoted",
  enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-08-03T23:05:11.143Z",
  updatedAt: "2026-08-03T23:05:11.143Z",
};

describe("against a row the production API actually returned", () => {
  afterEach(() => setActiveFormatZone(null));

  it("renders it whole, and still claims no count", async () => {
    setActiveFormatZone("UTC"); // 23:05Z is the next day east of UTC
    await renderSettings({ items: [PRODUCTION_RULE] });
    await openRulesPane();

    const text = host.textContent ?? "";
    expect(text).toContain("Mail from contact.442@quietharbor.invalid");
    expect(text).toContain("Files into Ohbox");
    expect(text).toContain("from a Screener decision");
    expect(text).toContain("3 Aug 2026");
    expect(text).not.toMatch(/\b0 messages\b/);
  });
});

describe("revoking", () => {
  it("does NOT dispatch on the first click; it shows the disclosure first", async () => {
    const seen = await renderSettings({ items: [rule()] });
    await openRulesPane();

    await act(async () => {
      clickText("Revoke");
    });

    expect(seen.revoked, "the first click revoked without disclosing anything").toEqual([]);
    expect(host.textContent).toContain(
      "This stops the rule deciding new mail. Mail it already filed stays where it is.",
    );
  });

  it("dispatches the revoke only on the confirm under that sentence", async () => {
    const seen = await renderSettings({ items: [rule({ id: "r-9" })] });
    await openRulesPane();

    await act(async () => {
      clickText("Revoke");
    });
    await act(async () => {
      clickText("Revoke this rule");
    });

    expect(seen.revoked).toEqual(["r-9"]);
  });

  it("cancel dispatches nothing and closes the disclosure", async () => {
    const seen = await renderSettings({ items: [rule()] });
    await openRulesPane();

    await act(async () => {
      clickText("Revoke");
    });
    await act(async () => {
      clickText("Cancel");
    });

    expect(seen.revoked).toEqual([]);
    expect(host.textContent).not.toContain("Mail it already filed stays where it is.");
  });
});

describe("changing where a rule files", () => {
  it("offers the sender sheet's five places, the one it already uses marked and not pressable", async () => {
    await renderSettings({ items: [rule({ destination: "INBOX" })] });
    await openRulesPane();
    await act(async () => {
      clickText("Change");
    });

    const places = [...host.querySelectorAll<HTMLButtonElement>(".rules-confirm .rules-places button")];
    expect(places.map((b) => b.textContent?.trim())).toEqual(["Ohbox", "News", "Receipts", "Screened out", "Spam"]);
    // "Ohbox" is where it already files: named so the list says where the rule is, never a press.
    const ohbox = places.find((b) => b.textContent?.trim() === "Ohbox")!;
    expect(ohbox.getAttribute("aria-current")).toBe("true");
    expect(ohbox.disabled).toBe(true);
  });

  it("with the past-mail switch off it discloses, before the choice, that mail already filed stays", async () => {
    await renderSettings({ items: [rule()] });
    await openRulesPane();
    await act(async () => {
      clickText("Change");
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.rules-confirm [role="switch"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.textContent).toContain("Mail already filed stays where it is.");
  });

  it("dispatches the chosen folder as a canonical path, not a label", async () => {
    const seen = await renderSettings({ items: [rule({ id: "r-3", destination: "INBOX" })] });
    await openRulesPane();
    await act(async () => {
      clickText("Change");
    });
    await act(async () => {
      clickText("News");
    });

    expect(seen.retargeted).toEqual([["r-3", "ohmail/News", true]]);
  });
});

/**
 * WHAT THE SURFACE SAYS HAPPENED — the defect a live account found and fixtures could not.
 *
 * The first cut toasted the moment the button was pressed, so a `403` on `DELETE /rules/:id`
 * produced "Rule revoked. Your mail hasn't moved." on screen while the optimistic tombstone
 * rolled back and the rule REAPPEARED. `FixturesAdapter` never refuses a mutation, so no
 * test could have seen it; it took a browser on the hosted service. These three cases are what
 * stop it coming back.
 */
describe("the toast reports the outcome, not the intent", () => {
  const revoke = async (status: MutationStatus) => {
    await renderSettings({ items: [rule()], status });
    await openRulesPane();
    await act(async () => {
      clickText("Revoke");
    });
    await act(async () => {
      clickText("Revoke this rule");
    });
    return host.textContent ?? "";
  };

  it("confirmed says the rule is gone and the mail has not moved", async () => {
    expect(await revoke("confirmed")).toContain("Rule revoked. Your mail hasn't moved.");
  });

  it("ROLLED BACK never claims the rule was revoked", async () => {
    const text = await revoke("rolled_back");
    expect(text).toContain("Couldn't revoke that rule. It's still in place.");
    expect(text, "a refused revoke reported success").not.toContain("Rule revoked.");
  });

  /**
   * `queued` is not success. The overlay stands and the row is gone from the screen, which is
   * right — but the server has not been told, and "revoked" is a claim about the server.
   */
  it("queued says queued, and does not claim the rule is revoked", async () => {
    // "Back online" is said only offline; the online arms are in
    // `rules-revoke-refused-is-not-offline.test.tsx`.
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      const text = await revoke("queued");
      expect(text).toContain("Revoke queued");
      expect(text).not.toContain("Rule revoked. Your mail hasn't moved.");
    } finally {
      Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("a refused destination change does not claim the destination changed", async () => {
    await renderSettings({ items: [rule({ destination: "INBOX" })], status: "rolled_back" });
    await openRulesPane();
    await act(async () => {
      clickText("Change");
    });
    await act(async () => {
      clickText("News");
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Couldn't change that rule. Nothing has changed.");
    expect(text).not.toContain("will go to News");
  });
});

/**
 * THE SEAM. `SettingsView` is shared with the desktop mirror and with `?demo=1`, and a shell
 * that has not wired rules must get NO PANE rather than an empty one — an empty list on an
 * account that has four rules is precisely the defect this guards.
 */
describe("an unwired shell gets no pane at all", () => {
  it("omits Rules from the nav when the prop is absent", async () => {
    await renderSettings(undefined);
    expect(buttons().map((b) => b.textContent?.trim())).not.toContain("Rules");
  });
});

describe("ruleDate", () => {
  afterEach(() => setActiveFormatZone(null));

  it("always carries the year — a standing decision outlives the current one", () => {
    setActiveFormatZone("UTC");
    expect(ruleDate("2025-01-09T23:30:00.000Z")).toBe("9 Jan 2025");
    expect(ruleDate("2026-08-04T00:00:00.000Z")).toBe("4 Aug 2026");
  });

  it("dates a rule by the reader's day: made at 00:59 in Zurich it reads that day, not UTC's", () => {
    setActiveFormatZone("Europe/Zurich");
    expect(ruleDate("2026-10-22T22:59:00.000Z")).toBe("23 Oct 2026");
    setActiveFormatZone("America/New_York");
    expect(ruleDate("2026-01-01T03:00:00.000Z")).toBe("31 Dec 2025");
  });

  it("renders nothing for an unparseable stamp rather than 'Invalid Date'", () => {
    expect(ruleDate("not a date")).toBe("");
  });
});

/**
 * THE MANAGEMENT SURFACE. The flat list did not scale, so the pane grew a search, a set of
 * destination facets, a windowed list and a bulk revoke. These guard the four behaviours a
 * regression would quietly break, and they are written so that removing the behaviour turns each
 * one red (proven by mutation, not by config).
 */
describe("grouping rules by destination", () => {
  it("buckets each rule under its own destination, canonical order first", () => {
    const groups = groupByDestination([
      rule({ id: "a", destination: "ohmail/News" }),
      rule({ id: "b", destination: "INBOX" }),
      rule({ id: "c", destination: "ohmail/News" }),
    ]);
    // INBOX comes before Reads (RULE_DESTINATIONS order), and nothing lands in the wrong bucket.
    expect(groups.map((g) => g.destination)).toEqual(["INBOX", "ohmail/News"]);
    expect(groups[0].rules.map((r) => r.id)).toEqual(["b"]);
    expect(groups[1].rules.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("returns no bucket for a destination with no rules", () => {
    const groups = groupByDestination([rule({ destination: "INBOX" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].destination).toBe("INBOX");
  });
});

describe("search over the rules list", () => {
  it("filterRules keeps only rules whose match contains the query, case-insensitively", () => {
    const rules = [
      rule({ id: "a", match: "alice@acme.example" }),
      rule({ id: "b", match: "bob@globex.example" }),
      rule({ id: "c", match: "carol@Acme.example" }),
    ];
    expect(filterRules(rules, "acme", "all").map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterRules(rules, "  ", "all").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("filterRules narrows to the chosen destination and combines with the query", () => {
    const rules = [
      rule({ id: "a", match: "alice@acme.example", destination: "INBOX" }),
      rule({ id: "b", match: "bob@acme.example", destination: "ohmail/News" }),
    ];
    expect(filterRules(rules, "acme", "ohmail/News").map((r) => r.id)).toEqual(["b"]);
  });

  it("typing in the search box drops the rows that no longer match", async () => {
    await renderSettings({
      items: [
        rule({ id: "a", match: "alice@acme.example" }),
        rule({ id: "b", match: "bob@globex.example" }),
        rule({ id: "c", match: "carol@acme.example" }),
      ],
    });
    await openRulesPane();
    expect(ruleRows()).toHaveLength(3);

    await typeSearch("acme");
    const shown = ruleRows().map((el) => el.getAttribute("data-rule-id"));
    expect(shown).toEqual(["a", "c"]);
    expect(host.textContent).not.toContain("bob@globex.example");
  });

  it("a query that matches nothing says so, and still says the count is not recorded", async () => {
    await renderSettings({
      items: [rule({ id: "a", match: "alice@acme.example" }), rule({ id: "b", match: "bob@acme.example" })],
    });
    await openRulesPane();
    await typeSearch("nobody-here");
    expect(ruleRows()).toHaveLength(0);
    expect(host.textContent).toContain("No rules match.");
    expect(host.textContent).toContain("Nothing records how many messages a rule has filed");
  });
});

describe("the destination facet", () => {
  it("clicking a destination chip narrows the list to that bucket", async () => {
    await renderSettings({
      items: [
        rule({ id: "i1", match: "a@x.example", destination: "INBOX" }),
        rule({ id: "r1", match: "b@x.example", destination: "ohmail/News" }),
        rule({ id: "cp1", match: "c@x.example", destination: "ohmail/Receipts" }),
      ],
    });
    await openRulesPane();
    // Three destinations → the facet chips are offered.
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(
      expect.arrayContaining(["All", "Ohbox", "News", "Receipts"]),
    );

    await act(async () => {
      clickText("News");
    });
    expect(ruleRows().map((el) => el.getAttribute("data-rule-id"))).toEqual(["r1"]);
  });
});

/**
 * THE NEWS PILE HAS TWO SPELLINGS: `ohmail/News` and the pre-0.22 `ohmail/Reads` its older rules still
 * carry. The organizer files both into one folder, so the pane shows one place. Read through `rulesList`, the door
 * the shell hands this pane, with the shape an account upgraded across the rename has: a new rule beside older ones.
 */
describe("both spellings of the News pile are ONE chip", () => {
  const LEGACY = LEGACY_NEWS_FOLDER as Folder;
  const tenIntoNews = (): RuleDTO[] => [
    rule({ id: "n0", match: "new@x.example", destination: "ohmail/News", createdAt: "2026-09-23T10:00:00.000Z" }),
    ...Array.from({ length: 9 }, (_, i) => rule({ id: `l${i}`, match: `old${i}@x.example`, destination: LEGACY })),
    rule({ id: "i0", match: "inbox@x.example", destination: "INBOX" }),
  ];
  async function readThroughTheDoor(rows: RuleDTO[]): Promise<RuleDTO[]> {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges(rows.map((r, i): SyncChange => ({
      type: "rule", op: "create", id: r.id, seq: i + 1, updatedAt: r.updatedAt, entity: r,
    })));
    return rulesList(store);
  }
  const chips = (): string[] =>
    [...host.querySelectorAll<HTMLButtonElement>(".rules-facets button")].map((b) => b.textContent?.trim() ?? "");

  it("one News chip holds all ten, and Revoke all covers all ten", async () => {
    const seen = await renderSettings({ items: await readThroughTheDoor(tenIntoNews()) });
    await openRulesPane();
    expect(chips()).toEqual(["All", "Ohbox", "News"]);
    await act(async () => {
      clickText("News");
    });
    await act(async () => {
      clickText("Revoke all 10 matching");
    });
    await act(async () => {
      clickText("Revoke 10 rules");
    });
    expect([...seen.revoked].sort()).toEqual(["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "n0"]);
  });

  it("a rule stored in the old spelling is not offered News as somewhere new", async () => {
    // Two senders: one sender's two rows are one row on this page (the twin the router runs).
    await renderSettings({ items: await readThroughTheDoor([rule({ id: "l0", destination: LEGACY }), rule({ id: "i0", match: "other@atelier-eichspan.example" })]) });
    await openRulesPane();
    const row = host.querySelector<HTMLElement>('[data-rule-id="l0"]')!;
    await act(async () => {
      [...row.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Change")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const places = [...host.querySelectorAll<HTMLButtonElement>(".rules-confirm .rules-places button")];
    expect(places.map((b) => b.textContent?.trim())).toEqual(["Ohbox", "News", "Receipts", "Screened out", "Spam"]);
    // The old spelling IS the News pile: marked as where it files, never offered as somewhere new.
    expect(places.filter((b) => b.disabled).map((b) => b.textContent?.trim())).toEqual(["News"]);
  });
});

describe("the long list is windowed", () => {
  it("mounts a viewport's worth of rows, not the whole set", async () => {
    const items = Array.from({ length: 1200 }, (_, i) =>
      rule({ id: `r-${i}`, match: `sender-${i}@example.com`, destination: "INBOX" }),
    );
    await renderSettings({ items });
    await openRulesPane();

    const mounted = ruleRows().length;
    expect(mounted).toBeGreaterThan(0);
    // A viewport's worth plus overscan — nowhere near the thousands of rows the list holds. The mutation
    // that removes `filtered.slice(win.start, win.end)` renders all 1200 and turns this red.
    expect(mounted).toBeLessThan(120);
  });
});

/**
 * SET-M4 — THE CONFIRM STANDS AT THE ROW IT IS ABOUT.
 *
 * The action region used to render ABOVE the list, so Change on the fortieth row of a deep
 * scroll drew the destination picker at the top of the pane — off-screen — with no marker on
 * the row being edited, and Cancel left the reader stranded up there. The confirm now renders
 * INSIDE the windowed list, immediately after its target row, and the row is marked while its
 * action is open. Bulk revoke keeps the top slot: it acts on the whole filtered set, so the
 * head of that set is exactly where its disclosure belongs.
 */
describe("SET-M4 — the confirm renders at the row, and the row is marked", () => {
  const three = [
    rule({ id: "r-1", match: "a@x.example" }),
    rule({ id: "r-2", match: "b@x.example" }),
    rule({ id: "r-3", match: "c@x.example" }),
  ];

  /** Click a labelled button INSIDE one rule row. */
  const clickInRow = async (ruleId: string, label: string): Promise<void> => {
    const row = host.querySelector(`[data-rule-id="${ruleId}"]`);
    if (!row) throw new Error(`no row for ${ruleId}`);
    const btn = [...row.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.trim() === label);
    if (!btn) throw new Error(`no "${label}" in row ${ruleId}`);
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("the destination picker is the target row's next sibling, not a detached block", async () => {
    await renderSettings({ items: three });
    await openRulesPane();
    await clickInRow("r-2", "Change");

    const row = host.querySelector('[data-rule-id="r-2"]')!;
    const next = row.nextElementSibling;
    expect(
      next?.classList.contains("rules-confirm"),
      "the picker did not render at the row it is changing",
    ).toBe(true);
    // …and it is INSIDE the scrolling list, so it travels with the row.
    expect(next?.closest(".rules-list"), "the confirm left the list").toBeTruthy();
  });

  it("the row whose action is open carries the editing marker; the others do not", async () => {
    await renderSettings({ items: three });
    await openRulesPane();
    await clickInRow("r-2", "Revoke");

    expect(host.querySelector('[data-rule-id="r-2"]')!.classList.contains("editing")).toBe(true);
    expect(host.querySelector('[data-rule-id="r-1"]')!.classList.contains("editing")).toBe(false);
    expect(host.querySelector('[data-rule-id="r-3"]')!.classList.contains("editing")).toBe(false);
  });

  it("cancel closes the confirm in place and clears the marker — nothing else moves", async () => {
    await renderSettings({ items: three });
    await openRulesPane();
    await clickInRow("r-2", "Change");
    await act(async () => {
      clickText("Cancel");
    });

    expect(host.querySelector(".rules-list .rules-confirm")).toBeNull();
    expect(host.querySelector('[data-rule-id="r-2"]')!.classList.contains("editing")).toBe(false);
    // All three rows are still mounted where they were.
    expect(ruleRows().map((el) => el.getAttribute("data-rule-id"))).toEqual(["r-1", "r-2", "r-3"]);
  });

  it("the row's own buttons say whether their confirm is open", async () => {
    await renderSettings({ items: three });
    await openRulesPane();
    const change = [...host.querySelector('[data-rule-id="r-2"]')!.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Change")!;
    expect(change.getAttribute("aria-expanded")).toBe("false");
    await clickInRow("r-2", "Change");
    expect(change.getAttribute("aria-expanded")).toBe("true");
  });

  it("bulk revoke's disclosure stays ABOVE the list — it is about the whole filtered set", async () => {
    await renderSettings({ items: three });
    await openRulesPane();
    await act(async () => {
      clickText("Revoke all 3 matching");
    });
    const confirm = host.querySelector(".rules-confirm");
    expect(confirm, "no bulk disclosure rendered").toBeTruthy();
    expect(confirm!.closest(".rules-list"), "the bulk confirm moved into the list").toBeNull();
  });
});

describe("bulk revoke acts over the FILTERED set, through the per-rule path", () => {
  it("revokes exactly the filtered rules — not all of them — after the two-click disclosure", async () => {
    const seen = await renderSettings({
      items: [
        rule({ id: "i1", match: "a@x.example", destination: "INBOX" }),
        rule({ id: "i2", match: "b@x.example", destination: "INBOX" }),
        rule({ id: "r1", match: "c@x.example", destination: "ohmail/News" }),
        rule({ id: "r2", match: "d@x.example", destination: "ohmail/News" }),
      ],
    });
    await openRulesPane();

    // Narrow to the Reads bucket — two of the four rules.
    await act(async () => {
      clickText("News");
    });
    expect(ruleRows()).toHaveLength(2);

    // First click reveals the disclosure and dispatches nothing.
    await act(async () => {
      clickText("Revoke all 2 matching");
    });
    expect(seen.revoked, "the bulk trigger revoked before the confirm").toEqual([]);
    expect(host.textContent).toContain("Mail it already filed stays where it is.");

    // The confirm under the sentence fans the SAME per-rule path over the filtered set only.
    await act(async () => {
      clickText("Revoke 2 rules");
    });
    expect([...seen.revoked].sort()).toEqual(["r1", "r2"]);
    expect(host.textContent).toContain("2 rules revoked. Your mail hasn't moved.");
  });
});

describe("a reader-only install lists the organizer's copy", () => {
  const items = [
    rule({ id: "local-1", match: "ann@shop.example", destination: "ohmail/Receipts" }),
    rule({ id: "local-2", match: "dee@shop.example", destination: "ohmail/Receipts" }),
    rule({ id: "held:bob", match: "bob@shop.example", destination: "ohmail/News" }),
    rule({ id: "held:cy", match: "cy@shop.example", destination: "ohmail/News" }),
  ];
  const key = (match: string) => ({ kind: "sender", match, subjectContains: null, bodyContains: null });
  const waits = (requestId: string, kind: string, match: string, destination?: string) => ({
    requestId, kind, state: "sent", holder: { name: "Laptop" }, mailboxId: "mb", decidedAt: "2026-08-03T10:00:00.000Z",
    refusedReason: null, target: { rule: key(match), ...(destination ? { destination } : {}) }, ruleId: null, messageId: null, slow: false,
  });
  // Laptop holds the mailbox and takes requests: the posture this list takes changes in.
  const more = (waiting: unknown[] = []) => ({
    source: "published", holder: "Laptop", waiting, posture: { mode: "pending", name: "Laptop" },
  });
  const row = (id: string) => ruleRows().find((r) => r.dataset.ruleId === id)!;

  // Changed on purpose: a rule made on the organizer was listed without controls while no press
  // here could name it. It is now changed or revoked by its key, relayed to the organizer.
  it("names the holder; a rule made there has Change and Revoke and takes part in a bulk revoke", async () => {
    const seen = await renderSettings({ items, more: more() });
    await openRulesPane();
    expect(host.textContent).toContain("Laptop organizes your mail, and these are the rules it files by.");
    expect([...row("held:bob").querySelectorAll("button")].map((b) => [b.textContent, b.disabled])).toEqual([["Change", false], ["Revoke", false]]);
    expect(host.textContent).not.toContain("change or revoke it there");
    await act(async () => { clickText("Revoke all 4 matching"); });
    await act(async () => { clickText("Revoke 4 rules"); });
    expect([...seen.revoked].sort()).toEqual(["held:bob", "held:cy", "local-1", "local-2"]);
  });

  it("a rule made there can be lifted over its domain's, and its controls wait outside posture pending", async () => {
    const lifted = [
      rule({ id: "held:bob", match: "bob@shop.example", destination: "ohmail/News" }),
      rule({ id: "held:dom", kind: "domain", match: "shop.example", destination: "ohmail/Screened", priority: 5 }),
    ];
    const seen = await renderSettings({ items: lifted, more: more() });
    await openRulesPane();
    await act(async () => { row("held:bob").querySelector<HTMLButtonElement>(".rules-lift")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(seen.retargeted).toEqual([["held:bob", "ohmail/News", false]]);
    await act(async () => { root!.unmount(); root = createRoot(host); });
    await renderSettings({ items: lifted, more: { ...more(), posture: { mode: "blocked", name: "Laptop", reason: "organizer_outdated" } } });
    await openRulesPane();
    expect([...row("held:bob").querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });

  it("a twin row's Revoke sends the local id", async () => {
    const seen = await renderSettings({ items, more: more() });
    await openRulesPane();
    await act(async () => { row("local-1").querySelectorAll("button")[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { clickText("Revoke this rule"); });
    expect(seen.revoked).toEqual(["local-1"]);
  });

  it("a waiting note rides its row by key: a create there reads as a change, a removal with no row still waits", async () => {
    await renderSettings({ items, more: more([waits("q1", "rule.create", "ann@shop.example", "INBOX"), waits("q2", "rule.delete", "gone@shop.example")]) });
    await openRulesPane();
    expect(row("local-1").textContent).toMatch(/Change to .* waits on Laptop/);
    expect(host.textContent).toContain("Removal waits on Laptop");
    expect(host.textContent).not.toContain("Removed here");
  });
});
