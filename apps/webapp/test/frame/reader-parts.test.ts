/**
 * TODAY'S TWO DOORS FIT THE READER'S PORTS (CHECK-JOIN-2 RULINGS (f), the doors' part built before the seating step).
 * The web shell's file door and picture door, as today's body makes them, are what the reader's `files` and
 * `pictures` ports declare, and the reader's body entry is what its `body` port takes. Held at the type level, by
 * the type checker that reads the web's tests (`tsc -p apps/webapp/tsconfig.json`): a member the reader comes to
 * require that today's door lacks is red there, before any shell hands the reader in. Nothing is mounted, and no
 * product file imports this; no host hands the reader (`reader: NONE` on every host until the seating step).
 */
import { describe, expectTypeOf, it } from "vitest";
import type { PictureSeam, ReaderFiles, ReaderParts } from "@ohmail/app/reader";
import { letterBody } from "@ohmail/app/reader/body";
import type { AttachmentsChrome } from "../../app/shell/attachments";
import type { RemoteImagesChrome } from "../../app/shell/remote-images";

describe("today's doors and the reader's ports", () => {
  it("today's file door is a ReaderFiles", () => {
    expectTypeOf<AttachmentsChrome>().toMatchTypeOf<ReaderFiles>();
  });

  it("today's picture door is a PictureSeam", () => {
    expectTypeOf<RemoteImagesChrome>().toMatchTypeOf<PictureSeam>();
  });

  it("the reader's body entry is what its body port takes", () => {
    expectTypeOf(letterBody).toMatchTypeOf<ReaderParts["body"]>();
  });
});
