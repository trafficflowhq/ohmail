/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RulesPane,
  rulesByDecider,
  rulesRevokable,
  rulesShown,
  rulesStates,
  type RuleItem,
  type RulesModel,
} from "../../../src/settings/rules/index.js";
import { Frame } from "../../../src/frame/Frame.js";
import { fakeHost, NO_ENGINE } from "../../support/fake-host.js";
import { fakeWindow } from "../../support/fake-window.js";
import { drawn, said } from "./words.js";

afterEach(cleanup);

const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const r = (key: string, lang: "en" | "de" = "en") => said(lang, "rules", key);

const PLACES = [
  { folder: "INBOX", name: "Ohbox", current: false },
  { folder: "ohmail/News", name: "News", current: false },
  { folder: "ohmail/Receipts", name: "Receipts", current: false },
];
const rule = (id: string, who: string, folder: string, more: Partial<RuleItem> = {}): RuleItem => ({
  id,
  who,
  person: who.includes("@") ? { name: who.split("@")[0]!, address: who } : null,
  what: `Mail from ${who}`,
  folder,
  place: PLACES.find((p) => p.folder === folder)!.name,
  origin: "from a Screener decision · 14 Nov 2026",
  byOhmail: false,
  notes: [],
  outranked: false,
  queued: false,
  places: PLACES.map((p) => ({ ...p, current: p.folder === folder })),
  finds: who.toLowerCase(),
  ...more,
});
const RULES = [
  rule("r1", "anna@example.org", "INBOX"),
  rule("r2", "example.com", "ohmail/News"),
  rule("r3", "shop@example.net", "ohmail/Receipts", { byOhmail: true }),
];
const FACETS = [
  { folder: "INBOX", name: "Ohbox" },
  { folder: "ohmail/News", name: "News" },
  { folder: "ohmail/Receipts", name: "Receipts" },
];
const STATES = rulesStates({
  rules: RULES,
  intro: null,
  introHeld: "Held by the laptop.",
  facets: FACETS,
  waiting: [
    { key: "w1", what: "Mail from bob@example.org", line: "Waiting on the laptop since 14 Nov 2026." },
  ],
  refusal: { lead: r("toastRevokeFailed"), why: "The laptop is not answering." },
  locked: "This computer reads; the laptop organizes.",
});
const model = (more: Partial<RulesModel> = {}): RulesModel => ({ ...STATES.rest.model, ...more });

describe("what the list shows", () => {
  it("finds a rule by its words and filters by where it files; a place no rule files into shows all", () => {
    const m = { rules: RULES, facets: FACETS };
    expect(rulesShown(m, " ANNA ", "all").map((x) => x.id)).toEqual(["r1"]);
    expect(rulesShown(m, "", "ohmail/News").map((x) => x.id)).toEqual(["r2"]);
    expect(rulesShown(m, "", "ohmail/Spam").map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("lists the person's own rules first, then the ones ohmail decided, and revokes none whose verb waits", () => {
    const { yours, ohmail } = rulesByDecider(RULES);
    expect([yours.map((x) => x.id), ohmail.map((x) => x.id)]).toEqual([["r1", "r2"], ["r3"]]);
    expect(
      rulesRevokable([...RULES, rule("r4", "x@example.org", "INBOX", { queued: true })]).map((x) => x.id),
    ).toEqual(["r1", "r2", "r3"]);
  });
});

describe("the Rules pane", () => {
  it("says there are no rules without the extra note", () => {
    drawn(<RulesPane model={STATES.empty.model} />);
    expect(seen(r("empty").replace(/\.$/u, ""))).toBe(true);
    expect(seen("Nothing records how many messages a rule has filed")).toBe(false);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("searches, filters by place and says when nothing matches", () => {
    drawn(<RulesPane model={model()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: r("searchLabel") }), {
      target: { value: "nobody" },
    });
    expect(seen(r("noMatch").replace(/\.$/u, ""))).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: r("facetLabel") })).getByRole("button", { name: "News" }),
    );
    expect(seen("example.com")).toBe(true);
    expect(seen("anna@example.org")).toBe(false);
  });

  it("revokes a rule only after saying that mail already filed stays where it is", () => {
    const revoke = vi.fn();
    drawn(<RulesPane model={model({ revoke })} />);
    fireEvent.click(screen.getAllByRole("button", { name: r("revoke") })[0]!);
    expect(revoke).not.toHaveBeenCalled();
    const ask = screen.getByRole("dialog");
    expect(ask.textContent).toContain(r("revokeExplain"));
    expect(ask.textContent).toContain("Mail from anna@example.org");
    fireEvent.click(within(ask).getByRole("button", { name: r("revoke") }));
    expect(revoke.mock.calls).toEqual([["r1"]]);
  });

  it("revokes every matching rule but a waiting one, after saying what stays", () => {
    const revokeAll = vi.fn();
    const rules = [...RULES, rule("r4", "x@example.org", "INBOX", { queued: true })];
    drawn(<RulesPane model={model({ rules, revokeAll })} />);
    fireEvent.click(screen.getByRole("button", { name: /Revoke all 3 matching/ }));
    const ask = screen.getByRole("dialog");
    expect(ask.textContent).toContain("Mail already filed stays where it is.");
    fireEvent.click(within(ask).getByRole("button", { name: r("revoke") }));
    expect(revokeAll.mock.calls).toEqual([[["r1", "r2", "r3"]]]);
  });

  it("changes where a rule files from its place, moving its past mail unless the person says not to", () => {
    const retarget = vi.fn();
    drawn(<RulesPane model={model({ retarget })} />);
    const slot = () => screen.getByRole("button", { name: r("filesInto").replace("{place}", "Ohbox") });
    fireEvent.click(slot());
    expect(isOff(screen.getByRole("menuitemradio", { name: "Ohbox" }))).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "News" }));
    fireEvent.click(slot());
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: r("moveAlreadyHere") }));
    expect(seen("Where new mail matching this rule should go.")).toBe(false);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Receipts" }));
    expect(retarget.mock.calls).toEqual([
      ["r1", "ohmail/News", true],
      ["r1", "ohmail/Receipts", false],
    ]);
  });

  it("lets nothing be pressed where this install only reads, and says why", () => {
    const revoke = vi.fn();
    drawn(<RulesPane model={{ ...STATES.held.model, revoke }} />);
    expect(seen("This computer reads; the laptop organizes.")).toBe(true);
    expect(screen.getAllByRole("button", { name: r("revoke") }).every(isOff)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: r("filesInto").replace("{place}", "Ohbox") }));
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("holds the verbs of a rule whose verb waits on this browser's queue", () => {
    drawn(
      <RulesPane
        model={model({
          rules: [rule("r1", "anna@example.org", "INBOX", { queued: true, notes: ["Not sent yet."] })],
        })}
      />,
    );
    expect(isOff(screen.getByRole("button", { name: r("revoke") }))).toBe(true);
    expect(seen("Not sent yet.")).toBe(true);
  });

  it("offers an outranked rule the way to decide again", () => {
    const lift = vi.fn();
    drawn(
      <RulesPane
        model={model({ lift, rules: [rule("r1", "anna@example.org", "INBOX", { outranked: true })] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: r("liftAction") }));
    expect(lift.mock.calls).toEqual([["r1"]]);
  });

  it("says a refused change on the pane, its lead and its reason", () => {
    drawn(<RulesPane model={STATES.refusedOther.model} />);
    expect(seen(said("en", "settingsRules", "notChanged"))).toBe(true);
    expect(seen(`${r("toastRevokeFailed")} The laptop is not answering.`)).toBe(true);
  });

  it("lists what waits on the install that organizes under its own head", () => {
    drawn(<RulesPane model={STATES.waiting.model} />);
    expect(screen.getByRole("heading", { name: "Waiting on the organizer" })).toBeTruthy();
    expect(seen("Waiting on the laptop since 14 Nov 2026.")).toBe(true);
  });

  it("opens the sender's card from their circle, and heads the rules ohmail decided", async () => {
    const contact = vi.fn();
    drawn(<RulesPane model={model({ contact })} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "anna" })));
    expect(contact.mock.calls[0]?.[0]).toBe("anna@example.org");
    expect(seen(r("groupByOhmail"))).toBe(true);
  });

  it("reads German where the catalogue is German", () => {
    drawn(<RulesPane model={STATES.empty.model} />, "de");
    expect(seen(r("empty", "de").replace(/\.$/u, ""))).toBe(true);
  });
});

it.each(["phone", "fold"] as const)("files into a chosen destination from the %s menu", (room) => {
  const { host } = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "account",
    window: fakeWindow(room),
    places: {
      ohbox: {
        id: "ohbox",
        body: "ohbox",
        rail: null,
        panes: { kind: "wide", Wide: () => <RulesPane model={model()} /> },
      },
    },
  });
  drawn(<Frame host={host} />);
  const slot = screen.getByRole("button", { name: r("facetLabel") });
  expect(screen.getByText("Files into")).toBeTruthy();
  expect(slot.textContent).toBe("All");
  fireEvent.click(slot);
  const menu = within(screen.getByRole("menu", { name: r("facetLabel") }));
  expect(menu.getByText("Files into")).toBeTruthy();
  fireEvent.click(menu.getByRole("menuitemradio", { name: "News" }));
  expect(slot.textContent).toBe("News");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(seen("example.com")).toBe(true);
  expect(seen("anna@example.org")).toBe(false);
});
