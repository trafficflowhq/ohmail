/** @vitest-environment jsdom */
import { act, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { message, mountShell, stubDom, unmountAll, waitFor } from "./_draft-shell.js";

const stored = message("archive-1", { subject: "The archive's copy" });
const other = message("other-9", { subject: "A different letter" });
const openRegion = (root: HTMLElement) => within(root).queryByRole("region", { name: "Open message" });

function storeAnswer() {
  return vi.fn<OhmailEngine["fetchMessage"]>(async (id) =>
    id === stored.id ? { state: "ready", message: stored } : { state: "missing" },
  );
}

async function visit(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
}

beforeEach(() => stubDom());
afterEach(unmountAll);

describe("the reader opens a message the mirror does not hold", () => {
  it("prefers the MIRROR's row whenever there is one — it carries this device's own state", async () => {
    const mirror = { ...stored, subject: "The mirror's copy" };
    const fetchMessage = storeAnswer();
    const { el } = await mountShell("#/search/m/archive-1", [other, mirror], [], {
      prepareEngine: (engine) => { engine.fetchMessage = fetchMessage; },
    });
    await waitFor(() => openRegion(el)?.textContent?.includes(mirror.subject) ?? false, "the mirror's letter");
    expect(openRegion(el)?.textContent).not.toContain(stored.subject);
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("never shows a held row for a DIFFERENT open", async () => {
    const fetchMessage = storeAnswer();
    const { el } = await mountShell("#/search/m/archive-1", [other], [], {
      prepareEngine: (engine) => { engine.fetchMessage = fetchMessage; },
    });
    await waitFor(() => openRegion(el)?.textContent?.includes(stored.subject) ?? false, "the store's letter");
    expect(fetchMessage).toHaveBeenCalledWith(stored.id);
    await visit("#/search/m/other-9");
    await waitFor(() => openRegion(el)?.textContent?.includes(other.subject) ?? false, "the other letter");
    expect(openRegion(el)?.textContent).not.toContain(stored.subject);
  });

  it("nothing open, nothing shown", async () => {
    const fetchMessage = storeAnswer();
    const { el } = await mountShell("#/search/m/archive-1", [other], [], {
      prepareEngine: (engine) => { engine.fetchMessage = fetchMessage; },
    });
    await waitFor(() => openRegion(el)?.textContent?.includes(stored.subject) ?? false, "the store's letter");
    await visit("#/search");
    await waitFor(() => openRegion(el) === null, "the reader closes");
    expect(within(el).queryByText(stored.subject)).toBeNull();
  });

  it("a carried row another mail client took away reads gone, never the stale row", async () => {
    const fetchMessage = storeAnswer();
    const { el } = await mountShell("#/search/m/archive-1", [other], [], {
      prepareEngine(engine) {
        engine.fetchMessage = fetchMessage;
        const gone = engine.messageIsGone.bind(engine);
        engine.messageIsGone = (id) => id === stored.id || gone(id);
      },
    });
    await waitFor(() => el.textContent?.includes("Moved or deleted elsewhere") ?? false, "the letter is gone");
    expect(within(el).queryByText(stored.subject)).toBeNull();
    expect(fetchMessage).not.toHaveBeenCalledWith(stored.id);
  });
});
