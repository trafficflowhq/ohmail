/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { routeOf } from "../../src/frame/route.js";
import { NONE } from "../../src/host/index.js";
import { NO_PANE_PARTS, NO_STAGE_PARTS, useMailSupplies } from "../../src/mail/index.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("opens Mailboxes from the desktop's browser handoff", () => {
  window.history.replaceState(null, "", "/mailbox?settings=mailboxes#/settings");
  const { result } = renderHook(() =>
    useMailSupplies(window, { face: "paper", scheme: "light" }, NONE, {
      reader: NONE,
      stageParts: NO_STAGE_PARTS,
      paneParts: NO_PANE_PARTS,
    }),
  );
  expect(routeOf(result.current.address.read())).toMatchObject({ place: "settings", sub: "mailboxes" });
});
