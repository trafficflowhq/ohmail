/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { browserClipboard } from "@ohmail/app/host/browser";

/** A window whose navigator holds this clipboard (or none). */
const windowWith = (clipboard: Partial<Clipboard> | undefined): Window =>
  ({ navigator: { clipboard } }) as unknown as Window;

describe("a browser shell's clipboard", () => {
  it("writes the text as it is handed, and says it was taken only once the clipboard took it", async () => {
    const written: string[] = [];
    const copy = browserClipboard(windowWith({ writeText: async (text: string) => void written.push(text) }));
    await expect(copy("ada@xn--bcher-kva.example")).resolves.toBe(true);
    expect(written).toEqual(["ada@xn--bcher-kva.example"]);
  });

  it("a refused write and a page with no clipboard say false, and never throw", async () => {
    const refused = browserClipboard(
      windowWith({
        writeText: async () => {
          throw new DOMException("not allowed", "NotAllowedError");
        },
      }),
    );
    await expect(refused("x@example.invalid")).resolves.toBe(false);
    await expect(browserClipboard(windowWith(undefined))("x@example.invalid")).resolves.toBe(false);
  });
});
