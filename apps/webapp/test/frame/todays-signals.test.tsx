/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createFeed, NONE, type HostContract, type LinkedDraft, type LinkIn } from "@ohmail/app/host";
import { useTodaysSignals, type TodaysSignalInputs } from "../../app/shell/todays-signals";

/** The two inputs a signal feeds: the paired host's silence, and a mail link handed in from outside. */
const seen: { now: TodaysSignalInputs | null } = { now: null };
function Probe({ signals }: { signals: HostContract["signals"] }) {
  seen.now = useTodaysSignals(signals);
  return null;
}
const QUIET = { hostConnection: NONE, linkIn: NONE, sessionState: NONE, copyAge: NONE, access: NONE, updateOffer: NONE, droppedFiles: NONE } as const;
const letter = (subject: string): LinkedDraft => ({ to: ["lena@example.com"], cc: [], bcc: [], subject, body: "" });

/** A host's link slot: offered links wait until taken, each taken once. */
function slot(): LinkIn & { offer(d: LinkedDraft): void; takes: number } {
  const waiting: LinkedDraft[] = [];
  const told = new Set<() => void>();
  const s = {
    takes: 0,
    take() { s.takes += 1; return waiting.shift() ?? null; },
    subscribe(arrived: () => void) { told.add(arrived); return () => told.delete(arrived); },
    offer(d: LinkedDraft) { waiting.push(d); for (const t of [...told]) t(); },
  };
  return s;
}
afterEach(cleanup);

describe("today's signal-fed inputs", () => {
  it("hands the host's silence on as it changes, and null or none as absent", () => {
    const feed = createFeed<HostContract["signals"]["hostConnection"] extends infer S ? (S extends { read(): infer T } ? T : never) : never>(null);
    render(<Probe signals={{ ...QUIET, hostConnection: feed }} />);
    expect(seen.now!.hostConnection).toBeUndefined();
    const quiet = { state: "stale" as const, words: { title: "Can't reach kestrel", detail: "", link: null } };
    act(() => feed.set(quiet));
    expect(seen.now!.hostConnection).toBe(quiet);
    act(() => feed.set(null));
    expect(seen.now!.hostConnection).toBeUndefined();
    cleanup();
    render(<Probe signals={QUIET} />);
    expect(seen.now).toMatchObject({ hostConnection: undefined, mailtoDraft: null, onMailtoDraftSeeded: undefined });
  });

  it("takes a link once when it arrives, holds it until seeded, and loses none to a double effect", () => {
    const links = slot();
    links.offer(letter("before mount"));
    render(<StrictMode><Probe signals={{ ...QUIET, linkIn: links }} /></StrictMode>);
    expect(seen.now!.mailtoDraft?.subject).toBe("before mount");
    act(() => seen.now!.onMailtoDraftSeeded!());
    expect(seen.now!.mailtoDraft).toBeNull();
    act(() => links.offer(letter("second")));
    expect(seen.now!.mailtoDraft?.subject).toBe("second");
    act(() => seen.now!.onMailtoDraftSeeded!());
    expect(seen.now!.mailtoDraft).toBeNull();
  });

  it("does not take on every render", () => {
    const links = slot();
    const { rerender } = render(<Probe signals={{ ...QUIET, linkIn: links }} />);
    const after = links.takes;
    const signals = { ...QUIET, linkIn: links };
    rerender(<Probe signals={signals} />);
    rerender(<Probe signals={signals} />);
    expect(links.takes).toBe(after);
  });
});
