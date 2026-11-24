/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useGapNotices,
  useOrganizerNotices,
  type GapNoticesInput,
  type OrganizerNoticesInput,
} from "@ohmail/app-logic/mailboxes/pane/notices";
import { NONE } from "../../../src/host/index.js";
import { A, B } from "./support.js";

/**
 * THE MAILBOXES' TWO NOTICES. Each is withheld where nothing can answer it; an answer is sent once per press, the
 * facts are read again after it, and a refusal is said on the notice's own line.
 */
const settle = (): Promise<void> => act(async () => {});
const AT = "2026-11-16T08:00:00.000Z";

const stopped = (id: string, address: string) => ({
  id,
  address,
  status: "connected",
  organizerRole: "reader" as const,
  organizedBy: { kind: "local", name: "Mila's MacBook", since: AT },
  organizerState: "stopped" as const,
  organizerEventAt: AT,
  organizerEventSeenAt: null,
});

type Facts = OrganizerNoticesInput["facts"];

describe("what changed about who organizes a mailbox", () => {
  it("is withheld where this shell cannot acknowledge it", () => {
    const { result } = renderHook(() =>
      useOrganizerNotices({
        facts: [stopped("a", A)] as Facts,
        acknowledge: NONE,
        refresh: () => {},
        open: () => {},
      }),
    );
    expect(result.current).toEqual([]);
  });

  it("names the mailbox that stopped, and Dismiss acknowledges it once and reads the facts again", async () => {
    const acknowledged: string[] = [];
    const refresh = vi.fn();
    const input: OrganizerNoticesInput = {
      facts: [stopped("a", A)] as Facts,
      acknowledge: async (id) => void acknowledged.push(id),
      refresh,
      open: () => {},
    };
    const { result } = renderHook(() => useOrganizerNotices(input));
    expect(result.current).toHaveLength(1);
    const [notice] = result.current;
    expect(notice!.kind).toBe("organizingStopped");
    expect(notice!.title).toMatchObject({ key: "noticeStopped", values: { address: A } });
    const dismiss = notice!.acts.find((a) => a.label.key === "noticeDismiss")!;
    act(() => dismiss.press());
    await settle();
    expect(acknowledged).toEqual(["a"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual([]);
  });

  it("a refused dismissal stays and says why on its own line", async () => {
    const input: OrganizerNoticesInput = {
      facts: [stopped("a", A), stopped("b", B)] as Facts,
      acknowledge: () => Promise.reject({ status: 402 }),
      refresh: () => {},
      open: () => {},
    };
    const { result } = renderHook(() => useOrganizerNotices(input));
    expect(result.current[0]!.title).toMatchObject({ key: "noticeStoppedMany", values: { count: 2 } });
    act(() => result.current[0]!.acts.find((a) => a.label.key === "noticeDismiss")!.press());
    await settle();
    expect(result.current).toHaveLength(1);
    expect(result.current[0]!.line).toEqual({ key: "noticeDismissInactive" });
  });

  it("keeps a refusal only while a change it describes is still visible", async () => {
    const original = stopped("a", A);
    const later = { ...original, organizerEventAt: "2026-11-16T09:00:00.000Z" };
    const other = stopped("b", B);
    const input: OrganizerNoticesInput = {
      facts: [original] as Facts,
      acknowledge: () => Promise.reject(new TypeError()),
      refresh: () => {},
      open: () => {},
    };
    const { result, rerender } = renderHook(useOrganizerNotices, { initialProps: input });
    act(() => result.current[0]!.acts.find((a) => a.label.key === "noticeDismiss")!.press());
    await settle();
    expect(result.current[0]!.line).toEqual({ key: "noticeDismissOffline" });

    rerender({ ...input, facts: [original, other] as Facts });
    expect(result.current[0]!.line).toEqual({ key: "noticeDismissOffline" });
    rerender({ ...input, facts: [] });
    expect(result.current).toEqual([]);
    rerender({ ...input, facts: [later, other] as Facts });
    expect(result.current[0]!.line).toBeUndefined();
  });

  it("does not show a late dismissal refusal under a new change", async () => {
    const original = stopped("a", A);
    let refuse!: (reason: unknown) => void;
    const input: OrganizerNoticesInput = {
      facts: [original] as Facts,
      acknowledge: () =>
        new Promise((_, reject) => {
          refuse = reject;
        }),
      refresh: vi.fn(),
      open: () => {},
    };
    const { result, rerender } = renderHook(useOrganizerNotices, { initialProps: input });
    act(() => result.current[0]!.acts.find((a) => a.label.key === "noticeDismiss")!.press());
    rerender({ ...input, facts: [stopped("b", B)] as Facts });
    refuse(new TypeError());
    await settle();
    expect(input.refresh).toHaveBeenCalledTimes(1);
    expect(result.current[0]!.line).toBeUndefined();
  });
});

describe("the letters that arrived while nothing organized a mailbox", () => {
  const facts = [
    { id: "a", address: A, status: "connected", organizerRole: "organizer", gapLetters: 3, gapStrangers: 0 },
  ] as GapNoticesInput["facts"];

  it("is withheld where this shell cannot answer it", () => {
    const { result } = renderHook(() => useGapNotices({ facts, answer: NONE, refresh: () => {} }));
    expect(result.current).toEqual([]);
  });

  it("files them by the rules on the press, with the counts it was offered, once", async () => {
    const answered: unknown[] = [];
    const { result } = renderHook(() =>
      useGapNotices({ facts, answer: async (id, a) => void answered.push([id, a]), refresh: () => {} }),
    );
    expect(result.current[0]!.title).toMatchObject({ key: "gapLetters", values: { count: 3, address: A } });
    act(() => result.current[0]!.acts[0]!.press());
    await settle();
    expect(answered).toEqual([["a", { file: true, count: 3, strangers: 0 }]]);
    expect(result.current).toEqual([]);
  });

  it("counts that changed since are said, and the offer stays", async () => {
    const { result } = renderHook(() =>
      useGapNotices({ facts, answer: () => Promise.reject({ status: 409 }), refresh: () => {} }),
    );
    act(() => result.current[0]!.acts[1]!.press());
    await settle();
    expect(result.current[0]!.line).toEqual({ key: "gapChanged" });
  });
});
