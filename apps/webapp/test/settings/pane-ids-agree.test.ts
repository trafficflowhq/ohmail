/**
 * THE THREE LISTS OF SETTINGS' SECTIONS AGREE: the Settings contract's menu order, the web's route
 * (`#/settings/<pane>`) and the frame's route. A section in one list only is either a menu entry no link
 * reaches, or a link that falls back to General while its pane exists.
 */
import { describe, expect, it } from "vitest";
import { PANES as FRAME_ROUTED, routeOf } from "@ohmail/app/frame/route";
import { PANE_IDS } from "@ohmail/app/settings/contract";
import { PANE_IDS as ROUTED } from "../../app/shell/routing";

describe("Settings' section ids", () => {
  it("are the same set in the contract, the web's route and the frame's route", () => {
    expect([...PANE_IDS].sort()).toEqual([...ROUTED].sort());
    expect([...PANE_IDS].sort()).toEqual([...FRAME_ROUTED].sort());
  });

  it("each survives the frame's route, and an unknown one does not", () => {
    for (const id of PANE_IDS) expect(routeOf(`#/settings/${id}`)).toMatchObject({ place: "settings", sub: id });
    expect(routeOf("#/settings/nowhere")).toMatchObject({ place: "settings", sub: null });
  });
});
