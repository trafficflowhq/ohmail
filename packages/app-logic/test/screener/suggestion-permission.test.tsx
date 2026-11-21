/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConsentState, type ConsentTransport } from "../../src/consent/consent-state.js";
import { useScreenerSuggestions, type SuggestWire } from "../../src/screener/screener-suggest.js";

afterEach(cleanup);

const sender = ["sender", "example.invalid"].join("@");
const translate = (key: string) => key;
const price: Awaited<ReturnType<SuggestWire["suggest"]>> = {
  dryRun: true,
  requested: 1,
  quoted: 1,
  quotedCredits: 1,
  quoteGrant: { proof: "fixture-quote", pairs: [{ sender, messageId: "m-1" }] },
  charged: 0,
  suggestions: [],
  skipped: [],
};

function mount(suggest = vi.fn<SuggestWire["suggest"]>().mockResolvedValue(price), initial = true) {
  let available = initial;
  let version = 1;
  const wire: SuggestWire = {
    configured: () => true,
    list: async () => ({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } }),
    suggest,
    messageFor: (_error, fallback) => fallback,
  };
  const options = {
    active: false,
    toast: () => undefined,
    text: { screener: translate, aiRefusal: translate },
    wire,
  };
  const grant = () => (available ? version : null);
  const hook = renderHook(
    ({ known }) =>
      useScreenerSuggestions({
        ...options,
        permission: { known, version, grant },
      }).forSenders([sender]),
    { initialProps: { known: initial } },
  );
  return {
    suggest,
    control: () => hook.result.current,
    read(known: boolean) {
      available = known;
      hook.rerender({ known });
    },
    refuseBeforeRender() {
      available = false;
    },
    revokeBeforeRender() {
      version++;
    },
  };
}

it("withholds hosted manual quotes without the current consent answer", async () => {
  const run = mount(undefined, false);
  await act(async () => {
    run.control().open();
  });
  expect(run.suggest).not.toHaveBeenCalled();
  expect(run.control().disabled).toBe(true);
});

it("invalidates a pending quote and its confirmation when a read fails", async () => {
  let reply!: (value: typeof price) => void;
  const run = mount(
    vi.fn(
      () =>
        new Promise<typeof price>((resolve) => {
          reply = resolve;
        }),
    ),
  );
  await act(async () => {
    run.control().open();
  });
  expect(run.suggest).toHaveBeenCalledTimes(1);
  act(() => run.read(false));
  await act(async () => {
    reply(price);
  });
  expect(run.control().phase).toBe("closed");
  expect(run.control().quote).toBeNull();

  act(() => run.read(true));
  await act(async () => {
    run.control().confirm();
  });
  expect(run.suggest).toHaveBeenCalledTimes(1);
});

it("checks consent again at the press even if the current button was drawn while consent was readable", async () => {
  const run = mount();
  await act(async () => {
    run.control().open();
  });
  expect(run.control().quote).toEqual({ senders: 1, credits: 1 });
  const confirm = run.control().confirm;
  run.refuseBeforeRender();
  await act(async () => {
    confirm();
  });
  expect(run.suggest).toHaveBeenCalledTimes(1);
});

it("cannot confirm a quote after a new Off answer, even before the control rerenders", async () => {
  const run = mount();
  await act(async () => {
    run.control().open();
  });
  expect(run.control().quote).toEqual({ senders: 1, credits: 1 });
  const confirm = run.control().confirm;
  run.revokeBeforeRender();
  await act(async () => {
    confirm();
  });
  expect(run.suggest).toHaveBeenCalledTimes(1);
});

it("withholds a queued quote when the live grant has changed", async () => {
  const reply = Promise.withResolvers<typeof price>();
  const run = mount(vi.fn<SuggestWire["suggest"]>().mockReturnValue(reply.promise));
  await act(async () => {
    run.control().open();
  });
  const maySend = run.suggest.mock.calls[0]?.[1]?.maySend;
  expect(maySend?.()).toBe(true);

  run.revokeBeforeRender();
  expect(maySend?.()).toBe(false);
  await act(async () => {
    reply.resolve(price);
  });
  expect(run.control().quote).toBeNull();
});

it("the live row withdraws the old grant when a later read turns off, fails, or recovers", async () => {
  let autoSuggestAt: string | null = "2026-09-15T08:00:00.000Z";
  let failed = false;
  const wire = {
    suggestionNeedsNetwork: false,
    state: async () => {
      if (failed) throw new Error("Read unavailable");
      return { dormancyDays: 90, autoSuggestAt };
    },
  } as ConsentTransport;
  const { result } = renderHook(() => useConsentState(true, "consent-grant-fixture", wire));
  const refresh = () =>
    act(async () => {
      window.dispatchEvent(new Event("online"));
    });

  await refresh();
  const on = result.current.readSuggestionGrant();
  expect(on).not.toBeNull();
  expect(result.current.readSuggestionGrant(true)).toBe(on);

  autoSuggestAt = null;
  await refresh();
  const off = result.current.readSuggestionGrant();
  expect(off).not.toBeNull();
  expect(off).not.toBe(on);
  expect(result.current.readSuggestionGrant(true)).toBeNull();

  failed = true;
  await refresh();
  expect(result.current.readSuggestionGrant()).toBeNull();

  failed = false;
  await refresh();
  expect(result.current.readSuggestionGrant()).not.toBeNull();
  expect(result.current.readSuggestionGrant()).not.toBe(off);
});

it.each(["failed", "incomplete"] as const)(
  "an Off press withdraws the grant and a %s read is honored while its write is pending",
  async (mode) => {
    const reply = (autoSuggestAt: string | null) => ({ dormancyDays: 90, autoSuggestAt });
    const affirmative = "2026-09-15T08:00:00.000Z";
    let read = async () => reply(affirmative) as Awaited<ReturnType<ConsentTransport["state"]>>;
    let finishWrite!: () => void;
    const wire = {
      suggestionNeedsNetwork: false,
      state: () => read(),
      setAutoSuggest: () =>
        new Promise((resolve) => {
          finishWrite = () => resolve({ autoSuggestAt: null });
        }),
    } as ConsentTransport;
    const { result } = renderHook(() => useConsentState(true, "pending-off-fixture", wire));
    await act(async () => {});
    expect(result.current.readSuggestionGrant(true)).not.toBeNull();

    let finishRead!: () => void;
    read = () =>
      new Promise((resolve, reject) => {
        finishRead = () => {
          if (mode === "failed") reject(new Error("Read unavailable"));
          else resolve({ dormancyDays: 90 } as Awaited<ReturnType<ConsentTransport["state"]>>);
        };
      });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    let write!: Promise<boolean>;
    act(() => {
      write = result.current.setAutoSuggest(false);
    });
    const onDuringWrite = result.current.readSuggestionGrant(true);
    await act(async () => {
      finishRead();
    });
    expect(onDuringWrite).toBeNull();
    expect(result.current.readSuggestionGrant()).toBeNull();
    await act(async () => {
      finishWrite();
      await write;
    });
    expect(result.current.readSuggestionGrant(true)).toBeNull();

    read = async () => reply(affirmative) as Awaited<ReturnType<ConsentTransport["state"]>>;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current.readSuggestionGrant(true)).not.toBeNull();
  },
);

it.each(["", "not-a-timestamp", "2026", "2026-02-30T10:00:00.000Z"])(
  "rejects an invalid suggestion timestamp in both reads and write echoes (%s)",
  async (malformed) => {
    const affirmative = "2026-09-15T08:00:00.000Z";
    let autoSuggestAt: string | null = malformed;
    const wire = {
      suggestionNeedsNetwork: false,
      state: async () => ({ dormancyDays: 90, autoSuggestAt }),
      setAutoSuggest: async () => ({ autoSuggestAt: malformed }),
    } as ConsentTransport;
    const { result } = renderHook(() => useConsentState(true, "timestamp-fixture", wire));
    const refresh = () =>
      act(async () => {
        window.dispatchEvent(new Event("online"));
      });

    await refresh();
    expect(result.current.readSuggestionGrant()).toBeNull();
    expect(result.current.autoSuggest).toBe(false);

    autoSuggestAt = null;
    await refresh();
    expect(result.current.suggestionConsentKnown).toBe(true);
    expect(result.current.readSuggestionGrant(true)).toBeNull();

    let refusal: unknown;
    await act(async () => {
      refusal = await result.current.setAutoSuggest(true).catch((error: unknown) => error);
    });
    expect(refusal).toBeInstanceOf(Error);
    expect(result.current.readSuggestionGrant()).toBeNull();
    expect(result.current.autoSuggest).toBe(false);

    autoSuggestAt = affirmative;
    await refresh();
    expect(result.current.autoSuggestAt).toBe(affirmative);
    expect(result.current.readSuggestionGrant(true)).not.toBeNull();
  },
);
