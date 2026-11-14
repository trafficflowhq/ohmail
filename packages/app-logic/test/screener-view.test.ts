/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScreenerSenderDTO } from "@ohmail/client-engine";
import { SHARED_PROVIDER_DOMAINS } from "@trafficflow/core/rule-order";
import {
  activeFilterOf,
  DECISION_KEY,
  filterChoices,
  filterCounts,
  isSharedDomain,
  nextAfterDecision,
  screenerKeys,
  suggestionWords,
  useScreenerView,
  type DecisionDestination,
  type KeySegment,
  type ScreenerKeyWords,
  type ScreenerModelInput,
  type ScreenerState,
  type ScreenerViewInput,
} from "@ohmail/app-logic/screener";

/**
 * THE SCREENER'S VIEW over a model double that records every call: a decision leaves once through the model's one
 * `decide` and opens the next sender below, a refused one stays put, Mark all spam asks before anything moves, and
 * selecting a sender asks the model for nothing.
 */

const sender = (id: string, over: Partial<ScreenerSenderDTO> = {}): ScreenerSenderDTO =>
  ({
    id,
    segment: "waiting",
    from: { name: id.toUpperCase(), address: `${id}@${id}.example` },
    initial: id[0]!.toUpperCase(),
    time: "2026-11-10T09:00:00.000Z",
    scope: "sender",
    derived: true,
    ai: null,
    held: [],
    ...over,
  }) as unknown as ScreenerSenderDTO;
const suggesting = (id: string, dest: string) => sender(id, { ai: { dest, reason: "r" } as never });

interface Calls {
  decide: { id: string; dest: DecisionDestination; read: boolean; scope: string }[];
  allSpam: string[][];
  applied: number;
}

function model(calls: Calls, over: Partial<ScreenerState> = {}): ScreenerState {
  return {
    waiting: [],
    screenedOut: [],
    spam: [],
    decided: [],
    suggestedCount: 0,
    role: { mode: "organizer", name: null, reason: null, oauthOnly: false },
    isExiting: () => false,
    decide: (s: ScreenerSenderDTO, dest: DecisionDestination, opts: { read: boolean; scope: string }) =>
      calls.decide.push({ id: s.id, dest, read: opts.read, scope: opts.scope }),
    markAllSpam: (_scopeOf: unknown, only?: (s: ScreenerSenderDTO) => boolean) => {
      const state = current!;
      calls.allSpam.push(state.waiting.filter((w) => only?.(w) ?? true).map((w) => w.id));
    },
    applyAll: () => {
      calls.applied += 1;
    },
    ...over,
  } as unknown as ScreenerState;
}
let current: ScreenerState | null = null;

const WORDS: ScreenerKeyWords = {
  next: "next",
  prev: "prev",
  accept: "accept",
  applyAll: "apply all",
  card: "card",
  segPrev: "section before",
  segNext: "section after",
  undo: "undo",
  close: "close",
  file: { ohbox: "file o", reads: "file r", receipts: "file c", screened: "file n", spam: "file x" },
  fileRead: { ohbox: "read o", reads: "read r", receipts: "read c", screened: "read n", spam: "read x" },
};

function view(state: ScreenerState, over: Partial<ScreenerViewInput> = {}) {
  current = state;
  const said = { went: [] as KeySegment[], undone: 0 };
  let selected: string | null = over.selected ?? null;
  const hook = renderHook(
    (props: { state: ScreenerState; selected: string | null }) =>
      useScreenerView({
        state: props.state,
        segment: "waiting",
        select: (id) => {
          selected = id;
        },
        go: (s) => said.went.push(s),
        undo: () => {
          said.undone += 1;
          return true;
        },
        words: WORDS,
        oneColumn: false,
        ...over,
        selected: props.selected,
      }),
    { initialProps: { state, selected } },
  );
  const again = () => hook.rerender({ state: current!, selected });
  /* The selection lives above the view; each step is drawn again with what it chose. */
  again();
  return {
    hook,
    said,
    selected: () => selected,
    again,
    key: (chord: string) => keyOf(hook.result.current.keys, chord),
  };
}

function keyOf(keys: ReturnType<typeof screenerKeys>, chord: string) {
  const k = keys.find((b) => b.chord === chord);
  if (!k) throw new Error(`no key ${chord}`);
  return k;
}
const press = (k: ReturnType<typeof keyOf>, shift = false) =>
  act(() => k.run(new KeyboardEvent("keydown", { shiftKey: shift })));

describe("who is open after a decision", () => {
  it("the sender below, else the nearest above, never a decided one, never the top", () => {
    const open = (id: string) => id !== "d";
    expect(nextAfterDecision(["a", "b", "c"], "b", open)).toBe("c");
    expect(nextAfterDecision(["a", "b", "c"], "c", open)).toBe("b");
    expect(nextAfterDecision(["a", "b", "c", "d"], "c", open)).toBe("b");
    expect(nextAfterDecision(["a"], "a", open)).toBeNull();
  });
});

describe("the filter", () => {
  it("counts the queue by suggestion, leaving out rows sliding away; an emptied group lets go", () => {
    const rows = [
      suggesting("a", "reads"),
      suggesting("b", "reads"),
      sender("c"),
      suggesting("d", "screener"),
    ];
    const counts = filterCounts(rows, (id) => id === "b");
    expect(counts).toMatchObject({ reads: 1, none: 2, ohbox: 0 });
    expect(activeFilterOf("reads", counts)).toBe("reads");
    expect(activeFilterOf("spam", counts)).toBeNull();
    expect(filterChoices(counts)).toEqual(["reads", "none"]);
    expect(filterChoices(filterCounts([sender("x")], () => false))).toEqual([]);
  });
});

describe("the keys", () => {
  const input = (over: Partial<Parameters<typeof screenerKeys>[0]> = {}) => ({
    words: WORDS,
    segment: "waiting" as KeySegment,
    step: { down: () => {}, up: () => {} },
    decidable: true,
    decide: () => {},
    suggested: null,
    applyAll: null,
    card: () => {},
    go: () => {},
    undo: () => {},
    escape: null,
    ...over,
  });

  it("are exactly the Screener's table: Shift only on the three that let a sender in", () => {
    const chords = screenerKeys(input())
      .map((k) => k.chord)
      .sort();
    expect(chords).toEqual(
      [
        "j",
        "k",
        "Escape",
        "Enter",
        "a",
        "s",
        "[",
        "]",
        "z",
        "o",
        "shift+o",
        "r",
        "shift+r",
        "c",
        "shift+c",
        "n",
        "x",
      ].sort(),
    );
    expect(Object.values(DECISION_KEY)).toEqual(["o", "r", "c", "n", "x"]);
  });

  it("Enter and a are inert without a real suggestion; Enter on a focused button is the button's", () => {
    const decided: string[] = [];
    const none = screenerKeys(input({ decide: (d) => decided.push(d) }));
    expect(keyOf(none, "Enter").disabled).toBe(true);
    expect(keyOf(none, "a").disabled).toBe(true);
    const some = screenerKeys(
      input({ suggested: "reads", applyAll: () => {}, decide: (d) => decided.push(d) }),
    );
    expect(keyOf(some, "Enter").disabled).toBe(false);
    expect(keyOf(some, "a").disabled).toBe(false);
    const button = document.createElement("button");
    expect(keyOf(some, "Enter").when?.({ target: button } as unknown as KeyboardEvent)).toBe(false);
    keyOf(some, "Enter").run(new KeyboardEvent("keydown"));
    expect(decided).toEqual(["reads"]);
    const elsewhere = screenerKeys(input({ segment: "spam", applyAll: () => {} }));
    expect(keyOf(elsewhere, "a").disabled).toBe(true);
  });

  it("[ and ] walk the sections without wrapping", () => {
    const went: string[] = [];
    const first = screenerKeys(input({ go: (s) => went.push(s) }));
    expect(keyOf(first, "[").disabled).toBe(true);
    keyOf(first, "]").run(new KeyboardEvent("keydown"));
    const last = screenerKeys(input({ segment: "spam", go: (s) => went.push(s) }));
    expect(keyOf(last, "]").disabled).toBe(true);
    keyOf(last, "[").run(new KeyboardEvent("keydown"));
    expect(went).toEqual(["screened", "screened"]);
  });
});

describe("the view over the model", () => {
  const fresh = (): Calls => ({ decide: [], allSpam: [], applied: 0 });

  it("a decision leaves once through the model and opens the next undecided sender below", () => {
    const calls = fresh();
    const v = view(model(calls, { waiting: [sender("a"), sender("b"), sender("c")] }), { selected: "b" });
    expect(v.hook.result.current.openId).toBe("b");
    press(v.key("o"));
    expect(calls.decide).toEqual([{ id: "b", dest: "ohbox", read: false, scope: "sender" }]);
    expect(v.selected()).toBe("c");
  });

  it("Shift marks read on the three that let a sender in; the scope chosen is the one sent", () => {
    const calls = fresh();
    const v = view(model(calls, { waiting: [sender("a", { scope: "domain" }), sender("b")] }), {
      selected: "a",
    });
    press(v.key("shift+r"));
    expect(calls.decide).toEqual([{ id: "a", dest: "reads", read: true, scope: "domain" }]);
  });

  it("a refused decision (an install that may not decide) leaves the selection where it was", () => {
    const calls = fresh();
    const role = { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false } as never;
    const v = view(model(calls, { waiting: [sender("a"), sender("b")], role }), { selected: "a" });
    press(v.key("x"));
    expect(calls.decide).toHaveLength(1);
    expect(v.selected()).toBe("a");
  });

  it("a press the model refuses because nothing organizes the mailbox yet stays put and asks nothing", () => {
    const calls = fresh();
    const role = { mode: "organizer", pressRefusal: { kind: "nobody" } } as never;
    const state = model(calls, {
      waiting: [sender("a"), sender("b")],
      role,
      decide: (() => undefined) as never,
      unsubClaimOf: (() => "sends") as never,
    });
    const v = view(state, { selected: "a" });
    press(v.key("o"));
    v.again();
    expect(v.selected()).toBe("a");
    press(v.key("n"));
    expect(v.hook.result.current.ask).toBeNull();
    expect(v.selected()).toBe("a");
  });

  it("a takeover this install asked for goes through and opens the next sender", () => {
    const calls = fresh();
    const role = {
      mode: "blocked",
      name: null,
      reason: "no_organizer",
      oauthOnly: false,
      takeoverAsked: true,
    };
    const v = view(model(calls, { waiting: [sender("a"), sender("b")], role: role as never }), {
      selected: "a",
    });
    press(v.key("o"));
    expect(calls.decide).toEqual([{ id: "a", dest: "ohbox", read: false, scope: "sender" }]);
    expect(v.selected()).toBe("b");
  });

  it("selecting and walking asks the model for nothing", () => {
    const calls = fresh();
    const v = view(model(calls, { waiting: [sender("a"), sender("b")] }), { selected: "a" });
    press(v.key("j"));
    v.again();
    expect(v.selected()).toBe("b");
    act(() => v.hook.result.current.select("a"));
    expect(calls).toEqual(fresh());
  });

  it("Mark all spam asks first: nothing moves before the yes, and the yes moves only the senders it named", () => {
    const calls = fresh();
    const state = model(calls, { waiting: [sender("a"), sender("b")] });
    const v = view(state);
    act(() => v.hook.result.current.askAllSpam());
    const asked = v.hook.result.current.ask;
    expect(asked?.kind === "allSpam" ? asked.senders.map((s) => s.id) : null).toEqual(["a", "b"]);
    expect(calls.allSpam).toEqual([]);
    current = model(calls, { waiting: [sender("a"), sender("b"), sender("late")] });
    v.again();
    act(() => v.hook.result.current.answerAllSpam(true));
    expect(calls.allSpam).toEqual([["a", "b"]]);
    act(() => v.hook.result.current.askAllSpam());
    act(() => v.hook.result.current.answerAllSpam(false));
    expect(calls.allSpam).toHaveLength(1);
  });

  it("Escape closes the question first, then what is open beside the sender", () => {
    const calls = fresh();
    const v = view(model(calls, { waiting: [sender("a")] }), { selected: "a" });
    expect(v.key("Escape").disabled).toBe(true);
    act(() => v.hook.result.current.show("card"));
    act(() => v.hook.result.current.askAllSpam());
    press(v.key("Escape"));
    expect(v.hook.result.current.ask).toBeNull();
    expect(v.hook.result.current.shown).toBe("card");
    press(v.key("Escape"));
    expect(v.hook.result.current.shown).toBeNull();
  });

  it("z hands the frame's one undo door the press", () => {
    const v = view(model(fresh(), { waiting: [sender("a")] }));
    press(v.key("z"));
    expect(v.said.undone).toBe(1);
  });

  it("the open sender stays in a filtered list when the filter is not theirs", () => {
    const calls = fresh();
    const rows = [suggesting("a", "reads"), suggesting("b", "spam"), suggesting("c", "reads")];
    const v = view(model(calls, { waiting: rows }), { selected: "a" });
    act(() => v.hook.result.current.filter.choose("reads"));
    v.again();
    expect(v.hook.result.current.rows.map((r) => ("pinned" in r ? r.sender.id : r.id))).toEqual(["a", "c"]);
    expect(v.selected()).toBe("a");
  });
});

describe("the shared providers", () => {
  it("isSharedDomain answers the core's list of shared providers, whatever the case", () => {
    const [anyShared] = [...SHARED_PROVIDER_DOMAINS];
    expect(isSharedDomain(`someone@${anyShared}`)).toBe(true);
    expect(isSharedDomain(`someone@${anyShared!.toUpperCase()}`)).toBe(true);
    expect(isSharedDomain("someone@firma.example")).toBe(false);
  });
});

describe("the model's input", () => {
  it("names every setting: a missing role, mirror or undo window does not compile", () => {
    const noRole = {} as Omit<ScreenerModelInput, "role">;
    const noPresented = {} as Omit<ScreenerModelInput, "presented">;
    const noWindow = {} as Omit<ScreenerModelInput, "releaseWindow">;
    // @ts-expect-error role is required: absent, the hook took any install for the organizer
    const a: ScreenerModelInput = noRole;
    // @ts-expect-error the presented mirror is required: absent, the queue was built from the raw one
    const b: ScreenerModelInput = noPresented;
    // @ts-expect-error the undo window is required: absent, Allow and Not spam offered no Undo
    const c: ScreenerModelInput = noWindow;
    expect([a, b, c]).toHaveLength(3);
  });
});

describe("what the open sender's sentence says", () => {
  const keys = (s: ScreenerSenderDTO) => suggestionWords(s).lines.map((l) => l.key);

  it("a real suggestion is the slot's proposal, with how sure it is and its reason", () => {
    const w = suggestionWords(
      sender("lena", { ai: { dest: "ohbox", confidence: 0.92, rationale: "A note" } as never }),
    );
    expect(w.dest).toBe("ohbox");
    expect(w.sure).toBe(0.92);
    expect(w.lines).toEqual([{ key: "aiWhy", values: { why: "A note" } }]);
  });

  it("a hold, a run that could not answer and no advice propose nothing, and each says why", () => {
    const hold = sender("h", { ai: { dest: "screener", confidence: 0.9, rationale: "" } as never });
    const cut = sender("c", {
      ai: { dest: "screener", confidence: 0, rationale: "x", noAnswer: "over_quote" } as never,
    });
    for (const s of [hold, cut, sender("n"), sender("q", { noAi: true })]) {
      expect(suggestionWords(s).dest).toBeNull();
      expect(suggestionWords(s).sure).toBeNull();
    }
    expect(keys(hold)).toEqual(["aiHolds"]);
    expect(keys(cut)).toEqual(["aiSkip.over_quote"]);
    expect(keys(sender("n"))).toEqual(["noSuggestion"]);
    expect(keys(sender("q", { noAi: true }))).toEqual(["noSuggestionNoAutoAi"]);
  });

  it("what ohmail measured comes first, before the model's advice", () => {
    const s = sender("x", {
      checked: {
        reason: "impersonation",
        brand: "Bank",
        domainShared: true,
        domain: "mail.example",
        list: true,
      },
      ai: {
        dest: "spam",
        confidence: 0.96,
        rationale: "",
        reasonCode: "impersonation",
        reasonBrand: "Bank",
      } as never,
    });
    expect(keys(s)).toEqual([
      "senderCheck.impersonationShared",
      "senderCheck.list",
      "aiReason.impersonation",
    ]);
  });
});
