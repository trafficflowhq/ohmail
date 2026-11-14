/** @vitest-environment jsdom */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FolderMoveWords } from "@ohmail/app-logic/folder";
import { useFolderMoveWords } from "../../src/folder/index.js";
import { draw } from "../places/lists-world.js";

afterEach(() => cleanup());

describe("a move into a folder, in the folder's words", () => {
  function Said({ lang, out }: { lang: "en" | "de"; out: (w: FolderMoveWords) => void }) {
    out(useFolderMoveWords());
    return <p>{lang}</p>;
  }
  it("names the machine to update, the folder that left, and the folder being changed, in both languages", () => {
    let en: FolderMoveWords | null = null;
    let de: FolderMoveWords | null = null;
    draw(<Said lang="en" out={(w) => (en = w)} />);
    cleanup();
    draw(<Said lang="de" out={(w) => (de = w)} />, "de");
    expect(en!.moved("Workshops")).toBe("Moved to Workshops.");
    expect(en!.outdated("Studio Mac")).toBe(
      "Studio Mac organizes this mailbox with an older ohmail, which can't move into folders. Update ohmail there.",
    );
    expect(en!.gone("Workshops")).toBe("“Workshops” is no longer on your mail server.");
    expect(en!.busy("Workshops")).toBe("“Workshops” is being changed. Try again in a moment.");
    for (const w of [en!, de!]) {
      for (const said of [
        w.moved("X"),
        w.outdated("Y"),
        w.outdatedUnknown(),
        w.nobody(),
        w.elsewhere("Y"),
        w.gone("X"),
        w.busy("X"),
        w.cannot("X"),
        w.refused(),
        w.queued("Y"),
        w.queued(null),
        w.waitingGone("X"),
        w.waitingLetterGone(),
        w.waitingUnreadable(),
      ])
        expect(said).not.toMatch(/folder\.|move\./);
    }
    expect(de!.outdated("Studio Mac")).toContain("Studio Mac");
    expect(de!.moved("Werkstatt")).toContain("Werkstatt");
  });

  function both(): { en: FolderMoveWords; de: FolderMoveWords } {
    let en: FolderMoveWords | null = null;
    let de: FolderMoveWords | null = null;
    draw(<Said lang="en" out={(w) => (en = w)} />);
    cleanup();
    draw(<Said lang="de" out={(w) => (de = w)} />, "de");
    return { en: en!, de: de! };
  }

  it("says the waiting list's three refusals of a move in both languages", () => {
    const { en, de } = both();
    expect(en.waitingGone("Workshops")).toBe(
      "Nothing moved — this mailbox no longer has a folder “Workshops”.",
    );
    expect(en.waitingLetterGone()).toBe("Nothing moved — the message is no longer in the mailbox.");
    expect(en.waitingUnreadable()).toBe(
      "Nothing moved — the install that organizes this mailbox couldn't read the request.",
    );
    expect(de.waitingGone("Werkstatt")).toBe(
      "Nichts verschoben — dieses Postfach hat keinen Ordner „Werkstatt“ mehr.",
    );
    expect(de.waitingLetterGone()).toBe("Nichts verschoben — die Nachricht liegt nicht mehr im Postfach.");
    expect(de.waitingUnreadable()).toBe(
      "Nichts verschoben — die Installation, die dieses Postfach organisiert, konnte die Anfrage nicht lesen.",
    );
  });

  it("says first that nothing moved where an organizer elsewhere refused the move: a 409 queued nothing", () => {
    const { en, de } = both();
    expect(en.elsewhere("Studio Mac")).toBe(
      "Nothing moved — Studio Mac organizes this mailbox, so moves into folders are made where it runs.",
    );
    expect(en.elsewhereUnknown!()).toBe(
      "Nothing moved — moves into folders are made where the install that organizes this mailbox runs.",
    );
    expect(de.elsewhere("Studio Mac")).toMatch(/^Nichts verschoben — Studio Mac organisiert dieses Postfach/);
    expect(de.elsewhereUnknown!()).toMatch(/^Nichts verschoben — /);
  });
});
