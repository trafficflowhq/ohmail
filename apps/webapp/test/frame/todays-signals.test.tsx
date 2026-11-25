/** @vitest-environment jsdom */
/**
 * THE TWO INPUTS A HOST's SIGNAL FEEDS, over the new shell: the paired host's
 * silence, which the frame says in its one slot (`FrameParts.tsx`, `ConnectionHost`), and a mail link handed in from
 * outside, which the mail ground takes for its one composer (`mail/ground/writing-inputs.ts`, `useHandedLetter`).
 * Today's adapter (`app/shell/todays-signals.ts`) leaves with the switch; its three promises are read here over the
 * frame and the ground that hold them now. `none` and a null answer are both absent.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMutation } from "@ohmail/wire";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { Frame, type FrameHost, type FramePlaces } from "@ohmail/app/frame";
import { createFeed, NONE, type HostConnectionState, type LinkedDraft, type LinkIn } from "@ohmail/app/host";
import { MailGround } from "@ohmail/app/mail";
/* The ground's mounts below the composer, by path, as `writing-mount.test.tsx` stands them: the case reads what the
   composer's mount would hand it, with no composer beside it to take the link first. */
import { ConsentMount } from "../../../../packages/app/src/mail/ground/ConsentMount.js";
import { MailStateMount } from "../../../../packages/app/src/mail/ground/MailStateMount.js";
import { PresentedMount } from "../../../../packages/app/src/mail/ground/PresentedMount.js";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { fakeHost } from "../../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../../packages/app/test/support/fake-window.js";
import { useWritingInputs } from "../../../../packages/app/test/support/writing-inputs.js";
import en from "../../messages/en.json";
import { engineOver, message, ROSTER, storeWith, stubDom, waitFor } from "../_draft-shell.js";

const WORDS = en as unknown as Messages;
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

/** What the composer's mount hands, read at the place on screen at its last render; `again` draws it once more. */
const seen: { now: ReturnType<typeof useWritingInputs> | null; again: () => void } = { now: null, again: () => undefined };
function Probe(): ReactNode {
  seen.now = useWritingInputs();
  const [, again] = useState(0);
  seen.again = () => again((n) => n + 1);
  return <output>the inputs</output>;
}
function GroundWithNoComposer({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <MailStateMount>
      <ConsentMount>
        <PresentedMount>{children}</PresentedMount>
      </ConsentMount>
    </MailStateMount>
  );
}
const Empty = (): ReactNode => <output>the Ohbox</output>;

/** A host over a real engine, its link slot and its silence as the case hands them; the ground the case names above. */
async function hostWith(o: {
  linkIn?: LinkIn;
  hostConnection?: ReturnType<typeof createFeed<HostConnectionState | null>>;
  probe: boolean;
}): Promise<FrameHost> {
  const sent: EngineMutation[] = [];
  const engine = engineOver(await storeWith([message("m1")], []), sent, { on: false }, { wait: null });
  if (o.hostConnection !== undefined) {
    const stale = { state: "stale" as const, asOf: new Date(Date.now() - 31 * 60_000).toISOString() };
    engine.freshness = () => stale;
  }
  const places: Partial<FramePlaces> = {
    ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: o.probe ? Probe : Empty } },
  };
  const { host } = fakeHost({
    engine,
    service: "managed",
    scope: "acc-a",
    places,
    above: o.probe ? GroundWithNoComposer : MailGround,
    mailboxes: async () => ROSTER,
    window: fakeWindow("desktop"),
    address: fakeAddress("#/ohbox"),
    ...(o.hostConnection !== undefined ? { hostConnection: o.hostConnection } : {}),
  });
  return o.linkIn !== undefined ? { ...host, signals: { ...host.signals, linkIn: o.linkIn } } : host;
}
const shell = (host: FrameHost): ReactNode => (
  <TextProvider locale="en" messages={WORDS} timeZone="UTC">
    <Frame host={host} />
  </TextProvider>
);
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) await act(async () => new Promise((r) => setTimeout(r, 5)));
};
/** What the frame's one slot says now. */
const slotSays = (): string => screen.queryAllByRole("status").map((el) => el.textContent ?? "").join(" ");

beforeEach(() => {
  localStorage.clear();
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  seen.now = null;
});
afterEach(() => {
  cleanup();
  resetComposerForTest();
});

describe("today's signal-fed inputs", () => {
  it("hands the host's silence on as it changes, and null or none as absent", async () => {
    const feed = createFeed<HostConnectionState | null>(null);
    await act(async () => {
      render(shell(await hostWith({ hostConnection: feed, probe: false })));
    });
    await rounds(8);
    expect(slotSays()).not.toContain("kestrel");
    const quiet = { state: "stale" as const, words: { title: "Can't reach kestrel", detail: "", link: null } };
    await act(async () => feed.set(quiet));
    expect(slotSays()).not.toContain("kestrel");
    const link = { label: "Open Mailboxes", href: "#/settings/mailboxes" };
    await act(async () => feed.set({ ...quiet, words: { ...quiet.words, link } }));
    await waitFor(() => slotSays().includes("Can't reach kestrel"), "the host's silence said in the frame's slot");
    expect(slotSays()).toContain("Can't reach kestrel");
    expect(screen.getByRole("button", { name: link.label })).toBeTruthy();
    await act(async () => feed.set(null));
    await rounds(4);
    expect(slotSays()).not.toContain("kestrel");
    cleanup();
    /* A host that is never paired (`none` for both signals): nothing of a host is said, and no link is handed. */
    await act(async () => {
      render(shell(await hostWith({ probe: true })));
    });
    await waitFor(() => seen.now !== null, "the composer's inputs");
    await rounds(8);
    expect(slotSays()).not.toContain("kestrel");
    expect(seen.now!.composer.mailtoDraft).toBeNull();
    /* `none`'s link is absent: there is nothing to seed, and saying it was seeded hands nothing. */
    await act(async () => seen.now!.composer.onMailtoDraftSeeded?.());
    expect(seen.now!.composer.mailtoDraft).toBeNull();
  }, 60_000);

  it("takes a link once when it arrives, holds it until seeded, and loses none to a double effect", async () => {
    const links = slot();
    links.offer(letter("before mount"));
    const host = await hostWith({ linkIn: links, probe: true });
    await act(async () => {
      render(<StrictMode>{shell(host)}</StrictMode>);
    });
    await waitFor(() => seen.now?.composer.mailtoDraft != null, "the link in the composer's inputs");
    expect(seen.now!.composer.mailtoDraft?.subject).toBe("before mount");
    await act(async () => seen.now!.composer.onMailtoDraftSeeded!());
    expect(seen.now!.composer.mailtoDraft).toBeNull();
    await act(async () => links.offer(letter("second")));
    expect(seen.now!.composer.mailtoDraft?.subject).toBe("second");
    await act(async () => seen.now!.composer.onMailtoDraftSeeded!());
    expect(seen.now!.composer.mailtoDraft).toBeNull();
  }, 60_000);

  it("does not take on every render", async () => {
    const links = slot();
    await act(async () => {
      render(shell(await hostWith({ linkIn: links, probe: true })));
    });
    await waitFor(() => seen.now !== null, "the composer's inputs");
    await rounds(4);
    const after = links.takes;
    await act(async () => seen.again());
    await act(async () => seen.again());
    expect(links.takes).toBe(after);
  }, 60_000);
});
