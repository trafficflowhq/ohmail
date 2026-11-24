/** @vitest-environment jsdom */
/**
 * THE READER'S PARTS ON THE MAIL GROUND (`useMailReaderParts`, `mailReader` of the mail entry). The reading column's
 * file door and picture door are the ground's two, by identity: the reader builds none of its own. Where the ground
 * stands no door the reader is handed `none`. The letter's renderer and the look at a file are the host's.
 */
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoorsContext, type Doors } from "@ohmail/app-logic/reader/doors";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
import { MailGround, mailReader, useMailReaderParts, type MailReaderHost } from "../../src/mail/index.js";
import type { PictureSeam, ReaderFiles } from "../../src/reader/index.js";
import { TextProvider } from "../../src/text/index.js";
import { bodyDouble, fakeMail, letter, READER_PLACE, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";

afterEach(cleanup);

const files = { hold: () => () => undefined } as unknown as ReaderFiles;
const pictures = { modeOf: () => "blocked" } as unknown as PictureSeam;
const look = (): void => undefined;
const HOST: MailReaderHost = { body: bodyDouble().body, look };
const over =
  (doors: Doors) =>
  ({ children }: { children: ReactNode }) => (
    <DoorsContext.Provider value={doors}>{children}</DoorsContext.Provider>
  );

describe("the reader's parts on the mail ground", () => {
  it("the file door and the picture door are the ground's two, the very objects; the renderer and the look are the host's", () => {
    const doors = { files, pictures } as unknown as Doors;
    const { result, rerender } = renderHook(() => useMailReaderParts(HOST), { wrapper: over(doors) });
    expect(result.current.files).toBe(files);
    expect(result.current.pictures).toBe(pictures);
    expect(result.current.body).toBe(HOST.body);
    expect(result.current.look).toBe(look);
    /* One record while neither door moved: the column draws again only when a door does. */
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("where the ground stands no door the reader is handed none: no tile, no picture, no control of its own", () => {
    const { result } = renderHook(() => useMailReaderParts({ ...HOST, look: NONE }), {
      wrapper: over({ files: undefined, pictures: undefined }),
    });
    expect(result.current.files).toBe("none");
    expect(result.current.pictures).toBe("none");
    expect(result.current.look).toBe("none");
  });

  it("with no ground above it says so at once, and answers no door somebody guessed", () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => renderHook(() => useMailReaderParts(HOST))).toThrow(/no doors stand above/);
    } finally {
      said.mockRestore();
    }
  });

  it("the host's reader over the ground draws the open letter through the host's renderer", () => {
    const double = bodyDouble();
    const reader = mailReader({ body: double.body, look: NONE });
    const mail = fakeMail([letter("m1")]);
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE },
      reader,
      above: MailGround,
      address: fakeAddress("#/ohbox/m/m1"),
    });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
    expect([...double.handed.keys()]).toEqual(["m1"]);
    expect(screen.getByRole("heading", { name: "Kiln schedule" })).toBeTruthy();
  });
});
