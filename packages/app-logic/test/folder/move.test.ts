import type { EngineMessage, EngineMutation, FolderEntity } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import type { EntityReader, MutationRejectedError, PressVerdict } from "@ohmail/client-engine";
import {
  folderMoveRefusal,
  foldersToMoveInto,
  folderWaitingRefusal,
  moveIntoFolder,
  type FolderMoveWords,
} from "../../src/folder/move.js";

/** MOVE INTO ANY FOLDER: which folders a letter may go to, the one act a press sends, and what each answer says. */

const letter = (over: Partial<EngineMessage> = {}): EngineMessage =>
  ({ id: "m1", mailboxId: "mb", folder: "INBOX", subject: "Kiln", ...over }) as unknown as EngineMessage;
const folder = (id: string, name: string, over: Partial<FolderEntity> = {}): FolderEntity => ({
  id,
  name,
  mailboxId: "mb",
  mailbox: "mila@ex.example",
  ...over,
});

/** The test's mirror; a press the seam paints moves the letter in it, as the engine paints a move at once. */
function mirror(
  messages: EngineMessage[],
  folders: FolderEntity[],
): EntityReader & { paint(m: EngineMutation): void } {
  const by = new Map(messages.map((m) => [m.id, { ...m }]));
  return {
    paint: (m: EngineMutation) => {
      const held = m.kind === "move" ? by.get(m.messageId) : undefined;
      if (held && m.kind === "move")
        by.set(m.messageId, { ...held, folder: m.folder as EngineMessage["folder"] });
    },
    get: (type: string, id: string) => (type === "message" ? by.get(id) : undefined),
    list: (type: string) => (type === "message" ? [...by.values()] : type === "folder" ? folders : []),
    entries: () => [],
    version: () => 1,
    stampOf: () => 1,
    stampExcept: () => 1,
  } as unknown as EntityReader & { paint(m: EngineMutation): void };
}

const WORDS: FolderMoveWords = {
  moved: (name) => `Moved to ${name}.`,
  outdated: (by) => `${by} runs an older ohmail: update it there to move into folders.`,
  outdatedUnknown: () => "The install that organizes this mailbox runs an older ohmail: update it there.",
  nobody: () => "Nothing organizes this mailbox.",
  elsewhere: (by) => `${by} organizes this mailbox, so this move is made there.`,
  gone: (name) => `“${name}” is no longer on your mail server.`,
  busy: (name) => `“${name}” is being changed. Try again in a moment.`,
  cannot: (name) => `This letter can't move to “${name}”.`,
  refused: () => "That didn't go through.",
  queued: (holder) => `Waiting for ${holder ?? "the organizer"}.`,
  waitingGone: (name) => `Not moved: the mailbox no longer lists “${name}”.`,
  waitingLetterGone: () => "Not moved: the message is no longer there.",
  waitingUnreadable: () => "Not moved: the organizer couldn't read the move.",
};

/**
 * The press seam over the test's mirror: the press is painted into the mirror before it answers (a refusal leaves it
 * as it was, the paint rolled back), and the filing door re-reads the facts after the answer, as the shell's does.
 */
function seam(answer: PressVerdict, painted?: { paint(m: EngineMutation): void }) {
  const sent: EngineMutation[] = [];
  const said: { sentence: string; undo: EngineMutation[] | null }[] = [];
  const steps: string[] = [];
  return {
    sent,
    said,
    steps,
    press: {
      dispatchPress: async (m: EngineMutation) => {
        sent.push(m);
        steps.push("press");
        if (answer.kind !== "refused") painted?.paint(m);
        steps.push("answer");
        return answer;
      },
      fileAndRefresh: <T>(dispatch: Promise<T>): Promise<T> => {
        const refresh = () => void steps.push("refresh");
        dispatch.then(refresh, refresh);
        return dispatch;
      },
      toastWithUndo: (sentence: string, inverses: readonly EngineMutation[]) =>
        said.push({ sentence, undo: [...inverses] }),
    },
    toast: (sentence: string) => said.push({ sentence, undo: null }),
  };
}

const refused = (code: string, details?: unknown): PressVerdict => ({
  kind: "refused",
  refusal: { code, details } as unknown as MutationRejectedError,
});

describe("which folders a letter may move into", () => {
  it("offers the folders of the letter's own mailbox, a folder being changed disabled, Junk and what is under it left out", () => {
    const folders = [
      folder("f1", "Workshops"),
      folder("f2", "Clients/Gartenlokal Rosa"),
      folder("f3", "Clients", { op: { kind: "rename", to: "Kunden" } }),
      folder("f4", "Junk"),
      folder("f5", "Junk/Old"),
      folder("f6", "Elsewhere", { mailboxId: "mb2" }),
    ];
    const m = letter();
    const offered = foldersToMoveInto(mirror([m], folders), m, { junkFolder: "Junk" });
    expect(offered.map((o) => [o.folder.name, o.disabled])).toEqual([
      ["Clients", true],
      ["Clients/Gartenlokal Rosa", false],
      ["Workshops", false],
    ]);
  });

  it("leaves out the folder the letter is in", () => {
    const m = letter({ folder: "Workshops" as EngineMessage["folder"] });
    const offered = foldersToMoveInto(mirror([m], [folder("f1", "Workshops"), folder("f2", "Archive")]), m, {
      junkFolder: null,
    });
    expect(offered.map((o) => o.folder.name)).toEqual(["Archive"]);
  });
});

describe("a move into a folder", () => {
  const into = folder("f2", "Clients/Gartenlokal Rosa");

  it("sends one move act with the folder's own path, and offers Undo back where the letter was", async () => {
    const m = letter();
    const world = mirror([m], [into]);
    // The press is painted before it answers: only a way back read before the press still names INBOX.
    const s = seam({ kind: "applied" }, world);
    const stood = await moveIntoFolder(s.press, world, s.toast, m, into, WORDS);
    expect(stood).toBe(true);
    expect(s.sent).toEqual([{ kind: "move", messageId: "m1", folder: "Clients/Gartenlokal Rosa" }]);
    expect(s.said).toEqual([
      { sentence: "Moved to Gartenlokal Rosa.", undo: [{ kind: "move", messageId: "m1", folder: "INBOX" }] },
    ]);
  });

  it("refused by an organizer that runs 1.0, names the machine to update, and offers no Undo", async () => {
    const m = letter();
    const s = seam(
      refused("organized_elsewhere", { reason: "organizer_outdated", by: { name: "Studio Mac" } }),
    );
    const stood = await moveIntoFolder(s.press, mirror([m], [into]), s.toast, m, into, WORDS);
    expect(stood).toBe(false);
    expect(s.said).toEqual([
      { sentence: "Studio Mac runs an older ohmail: update it there to move into folders.", undo: null },
    ]);
  });

  it("waits for the organizer where a reading install recorded it, and says so, with no Undo", async () => {
    const m = letter();
    const s = seam({ kind: "queued", wait: "organizer", holder: "Studio Mac" });
    expect(await moveIntoFolder(s.press, mirror([m], [into]), s.toast, m, into, WORDS)).toBe(false);
    expect(s.said).toEqual([{ sentence: "Waiting for Studio Mac.", undo: null }]);
  });

  it("a newer press for the same letter says nothing for this one", async () => {
    const m = letter();
    const s = seam({ kind: "silent" });
    expect(await moveIntoFolder(s.press, mirror([m], [into]), s.toast, m, into, WORDS)).toBe(true);
    expect(s.said).toEqual([]);
  });

  it.each([
    ["applied", { kind: "applied" }],
    ["queued", { kind: "queued", wait: "organizer", holder: "Studio Mac" }],
    ["refused", refused("conflict")],
  ] as [string, PressVerdict][])(
    "goes through the one filing door: the facts are read again after the answer (%s)",
    async (_, verdict) => {
      const m = letter();
      const world = mirror([m], [into]);
      const s = seam(verdict, world);
      await moveIntoFolder(s.press, world, s.toast, m, into, WORDS);
      await Promise.resolve();
      expect(s.steps).toEqual(["press", "answer", "refresh"]);
    },
  );

  it("the same folder pressed again while the first press stands is no second act and says one thing", async () => {
    const m = letter();
    const world = mirror([m], [into]);
    const s = seam({ kind: "applied" }, world);
    await moveIntoFolder(s.press, world, s.toast, m, into, WORDS);
    expect(await moveIntoFolder(s.press, world, s.toast, m, into, WORDS)).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(s.said.map((x) => x.sentence)).toEqual(["Moved to Gartenlokal Rosa."]);
  });
});

describe("what the waiting list says of a move the organizer refused", () => {
  const name = "Clients/Gartenlokal Rosa";
  it.each([
    ["no_such_folder", "Not moved: the mailbox no longer lists “Gartenlokal Rosa”."],
    ["no_such_message", "Not moved: the message is no longer there."],
    ["invalid_payload", "Not moved: the organizer couldn't read the move."],
    ["stale", "That didn't go through."],
    [null, "That didn't go through."],
  ] as [string | null, string][])("%s", (reason, sentence) => {
    expect(folderWaitingRefusal(reason, name, WORDS)).toBe(sentence);
  });
});

describe("what a refused move says", () => {
  const name = "Clients/Gartenlokal Rosa";
  it.each([
    [
      refused("organized_elsewhere", { reason: "organizer_outdated", by: { name: "Studio Mac" } }),
      "Studio Mac runs an older ohmail: update it there to move into folders.",
    ],
    [
      refused("organized_elsewhere", { reason: "organizer_outdated" }),
      "The install that organizes this mailbox runs an older ohmail: update it there.",
    ],
    [refused("organized_elsewhere", { reason: "no_organizer" }), "Nothing organizes this mailbox."],
    [
      refused("organized_elsewhere", { by: { name: "Studio Mac" } }),
      "Studio Mac organizes this mailbox, so this move is made there.",
    ],
    [refused("no_such_folder"), "“Gartenlokal Rosa” is no longer on your mail server."],
    [refused("conflict"), "“Gartenlokal Rosa” is being changed. Try again in a moment."],
    [refused("not_found"), "This letter can't move to “Gartenlokal Rosa”."],
    [refused("validation_failed"), "That didn't go through."],
    [{ kind: "refused", refusal: undefined } as PressVerdict, "That didn't go through."],
  ])("%#", (verdict, sentence) => {
    expect(folderMoveRefusal(verdict.kind === "refused" ? verdict.refusal : undefined, name, WORDS)).toBe(
      sentence,
    );
  });
});
