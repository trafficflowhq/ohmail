/** @vitest-environment jsdom */
/**
 * THE SENDER'S CIRCLE IS ON EVERY VIEWER PANEL, AND IT IS THE LIST'S CIRCLE.
 *
 * The list and the open message describe the same person, so they must wear the same face:
 * the small initials circle, derived the one way everything derives it — the display name's
 * first letter (the address's where there is no name), and a hue that is a pure function of
 * the ADDRESS (`avatarHue`, the kit's `hue.ts`). The viewer redesign put a `MessageHeader` on every
 * per-message panel; before it, the reading pane had NO circle at all, which is how a thread
 * could show its people in the list and then drop them the moment it was opened. These guards
 * hold the repaired state:
 *
 *   · EVERY panel header carries its own sender's circle — the focused message and each
 *     conversation sibling alike, and the single-message pane too.
 *   · The derivation is IDENTICAL to the list's, asserted DOM-to-DOM: a `MessageRow` drawn for
 *     the same people carries the same letter and the same `--av-h` on its lead and on its
 *     strip faces as the viewer's headers do. A viewer that keyed the hue on the display name,
 *     or took its initial from somewhere else, goes red here — that is the drift this file
 *     exists to catch, because each half looks completely normal on its own.
 *   · The derivation is DETERMINISTIC: same input, same output, no per-render or per-session
 *     free variable. (The hue table itself is pinned in `shell-screening-bulk.test.ts`.)
 *
 * Over the new reader's letters (each head the kit's `MessageHead`, its circle the kit's `Avatar`)
 * and, for the list half, the kit's `Row` handed the people the Ohbox's group hands it
 * (`peopleOf` over `senderName`, as `packages/app/src/ohbox/OhboxGroup.tsx` and its seat do). A
 * face is its letter and its hue's colour (`--oh-hue-bg`), read off the circle the head draws.
 */

import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Avatar, avatarHue, hueStyle } from "@ohmail/ui/base";
import { Row } from "@ohmail/ui/mail";
import { senderName } from "@ohmail/app-logic/text/format";
import { peopleOf } from "../../../packages/app/src/ohbox/row-words.js";
import { mountReader } from "../../../packages/app/test/reader/support/mail.js";

/** Two voices, deliberately unalike: a named sender, and a bare address with no display name —
 * the fallback derivation (first letter of the LOCAL PART) is part of what is under guard. */
const ANDI = { name: "Andi Berger", address: "andi@bergerweb.example" };
const BARE = { name: null, address: "mila@trafficflow.example" };

function msg(
  id: string,
  from: { name: string | null; address: string },
  date: string,
  threadId: string | null,
): EngineMessage {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId,
    messageIdHeader: null,
    subject: `subj-${id}`,
    from,
    to: [],
    cc: [],
    date,
    folder: "INBOX",
    snippet: `snippet-${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: date,
  } as unknown as EngineMessage;
}

const A = msg("a", ANDI, "2026-07-30T09:00:00.000Z", "t1");
const G = msg("g", BARE, "2026-07-31T09:00:00.000Z", "t1");

afterEach(() => cleanup());

interface Face { letter: string; hue: string }
/** The circle: the one hidden element carrying a person's hue, its letter and its colour. */
function faceOf(el: Element | null): Face {
  expect(el, "no sender circle").not.toBeNull();
  const style = (el as HTMLElement).style;
  return { letter: (el!.firstChild?.textContent ?? "").trim(), hue: style.getPropertyValue("--oh-hue-bg") };
}
const circleIn = (scope: Element | null): Element | null =>
  scope?.querySelector('[aria-hidden="true"][style*="--oh-hue-bg"]') ?? null;
/** The circle in the head of the letter `id` of the open conversation. */
function headerFace(id: string): Face {
  return faceOf(circleIn(document.querySelector(`[data-conv-id="${id}"]`)));
}
const hueOf = (address: string): string => String(hueStyle(avatarHue(address))["--oh-hue-bg" as never]);

describe("every viewer panel header wears its sender's circle", () => {
  it("a conversation: the focused panel and each sibling carry their OWN sender's face", async () => {
    // Mutation that must go red: remove the <Avatar> from the kit's `MessageHead` — every face
    // below is missing. The head is ONE component worn by every letter of the column, so one
    // mutation point covers the opened letter and the siblings alike.
    mountReader({ letters: [A, G], open: "a" });

    const andi = headerFace("a");
    expect(andi.letter).toBe("A");
    expect(andi.letter).toBe([...senderName(A)][0]!.toUpperCase());
    expect(andi.hue).toBe(hueOf(ANDI.address));

    // The no-name sender: the letter falls back to the address's local part — and the hue is
    // keyed on the ADDRESS either way, so a person is one colour with or without a name.
    const mila = headerFace("g");
    expect(mila.letter).toBe("M");
    expect(mila.letter).toBe([...senderName(G)][0]!.toUpperCase());
    expect(mila.hue).toBe(hueOf(BARE.address));
  });

  it("a single message keeps the same circle in its one header", async () => {
    mountReader({ letters: [msg("solo", ANDI, "2026-07-30T09:00:00.000Z", null)], open: "solo" });
    const face = headerFace("solo");
    expect(face.letter).toBe("A");
    expect(face.hue).toBe(hueOf(ANDI.address));
  });
});

describe("the list and the viewer derive one identity per address", () => {
  it("a MessageRow's lead and strip faces carry the SAME letter and hue as the viewer's headers", async () => {
    // The viewer half.
    mountReader({ letters: [A, G], open: "a" });
    const viewer = { a: headerFace("a"), g: headerFace("g") };

    // The list half: a row drawn with the Ohbox's own derivation for the same people — the
    // group's people via `peopleOf` over `senderName`, as `OhboxGroup.tsx` hands the kit's Row.
    // DOM-to-DOM, so a viewer that re-derived either fact its own way (hue off the display
    // name, initial off something else) splits the two and goes red.
    const { people } = peopleOf([{ letter: A, you: false }, { letter: G, you: false }], senderName, "you", "en");
    const row = render(<Row who="Andi Berger" people={people} subject="subj" />);
    const faces = [...row.container.querySelectorAll('[aria-hidden="true"][style*="--oh-hue-bg"]')].map(faceOf);
    expect(faces).toHaveLength(2);

    // One person, one face, both surfaces: letter AND hue agree exactly.
    expect(faces[0]).toEqual(viewer.a);
    expect(faces[1]).toEqual(viewer.g);
  });

  it("the derivation is deterministic — same input, same output, every time", async () => {
    // A per-render or per-session free variable (a random seed, a Date.now() salt) breaks
    // repeated calls apart; a pure function cannot.
    for (const address of [ANDI.address, BARE.address, "someone@else.example"]) {
      expect(avatarHue(address)).toBe(avatarHue(address));
    }
    const letterOf = (name: string): string =>
      (render(<Avatar name={name} address="x@y.example" />).container.firstElementChild?.firstChild?.textContent ?? "");
    expect(letterOf("Andi Berger")).toBe("A");
    expect(letterOf("mila@trafficflow.example")).toBe("M");
    expect(letterOf(" andi@bergerweb.example")).toBe("A");
  });
});
