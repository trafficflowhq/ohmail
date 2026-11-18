/** @vitest-environment jsdom */
import type { EngineMessage, FolderEntity } from "@ohmail/wire";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FolderRail, type FolderRailProps } from "../../src/folder/index.js";
import { draw, msg } from "../places/lists-world.js";

/** THE RAIL'S FOLDERS: the shelf, All folders in place, a folder's menu, and the drop while a row is dragged. */

const folder = (name: string, mailboxId = "mb"): FolderEntity => ({
  id: `${mailboxId}:${name}`,
  name,
  mailboxId,
  mailbox: `${mailboxId}@ex.example`,
});
const FOLDERS = [
  "Archive",
  "Clients",
  "Clients/Gartenlokal Rosa",
  "Clients/Hostwerk",
  "Receipts 2026",
  "Steuern 2009",
  "Steuern 2010",
  "Workshops",
  "Zines",
].map((name) => folder(name));
const MAIL: EngineMessage[] = [
  msg({ id: "u1", folder: "Clients/Hostwerk", unread: true }),
  msg({ id: "u2", folder: "Clients/Hostwerk", unread: true }),
  msg({ id: "u3", folder: "Zines", unread: true }),
  msg({ id: "r1", folder: "Zines", unread: false }),
];

interface Said {
  went: string[];
  pins: string[];
}

function Rail(props: {
  said: Said;
  pinned?: string[];
  recent?: string[];
  open?: string | null;
  drag?: FolderRailProps["drag"];
}) {
  const [pinned, setPinned] = useState(props.pinned ?? []);
  return (
    <FolderRail
      folders={FOLDERS}
      messages={MAIL}
      shelf={{
        pinned,
        recent: props.recent ?? [],
        pin: (key) => {
          props.said.pins.push(`pin ${key}`);
          setPinned((was) => [...was, key]);
        },
        unpin: (key) => {
          props.said.pins.push(`unpin ${key}`);
          setPinned((was) => was.filter((k) => k !== key));
        },
      }}
      open={props.open ?? null}
      go={(f) => props.said.went.push(f.name)}
      drag={props.drag ?? null}
    />
  );
}

const fresh = (): Said => ({ went: [], pins: [] });
/** The shelf's folders, as the rail lists them: the entries between Folders and All folders. */
function shelfNames(): string[] {
  const entries = [...document.querySelectorAll<HTMLElement>(".oh-railentry")];
  const names = entries.map((e) => e.querySelector(".oh-railentry-name")?.textContent ?? "");
  return names.slice(1, names.indexOf("All folders"));
}

afterEach(() => cleanup());

describe("the rail's folders", () => {
  it("stand the shelf: pinned, the open one, the ones used last, then the tree's first level; a press opens one", () => {
    const said = fresh();
    draw(<Rail said={said} pinned={["mb|Zines"]} open="mb|Workshops" recent={["mb|Steuern 2010"]} />);
    expect(shelfNames()).toEqual([
      "Zines",
      "Workshops",
      "Steuern 2010",
      "Archive",
      "Clients",
      "Receipts 2026",
      "Steuern 2009",
    ]);
    expect(screen.getByRole("button", { name: "Workshops" }).getAttribute("aria-current")).toBe("page");
    // A folder with unread mail says how much, in its name for a screen reader too.
    expect(screen.getByRole("button", { name: "Zines, 1 unread" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Steuern 2010" }));
    expect(said.went).toEqual(["Steuern 2010"]);
  });

  it("opens All folders in place, never a place: a branch opens its folders, a shut one counts its unread", () => {
    const said = fresh();
    draw(<Rail said={said} pinned={["mb|Zines"]} />);
    const all = screen.getByRole("button", { name: /All folders/ });
    expect(all.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(all);
    const tree = screen.getByRole("tree", { name: "All folders" });
    // Clients is shut: it counts the unread mail of what lies in it, and its folders do not stand.
    expect(within(tree).getByRole("button", { name: "Clients, 2 unread" })).toBeTruthy();
    expect(within(tree).queryByRole("button", { name: /Hostwerk/ })).toBeNull();
    fireEvent.click(within(tree).getByRole("button", { name: "Expand Clients" }));
    expect(within(tree).getByRole("button", { name: "Hostwerk, 2 unread" })).toBeTruthy();
    expect(within(tree).getByRole("button", { name: "Clients" })).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "Hostwerk, 2 unread" }));
    expect(said.went).toEqual(["Clients/Hostwerk"]);
  });

  it("a folder's menu pins it to the shelf, and on a pinned one takes the pin off", () => {
    const said = fresh();
    draw(<Rail said={said} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Receipts 2026" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(said.pins).toEqual(["pin mb|Receipts 2026"]);
    expect(shelfNames()[0]).toBe("Receipts 2026");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Receipts 2026" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(said.pins).toEqual(["pin mb|Receipts 2026", "unpin mb|Receipts 2026"]);
  });

  it("while a row is dragged, each folder that takes it says so, the one under the pointer most", () => {
    draw(<Rail said={fresh()} drag={{ over: "mb|Clients", takes: (f) => f.name !== "Archive" }} />);
    const drop = (name: string) => screen.getByRole("button", { name }).getAttribute("data-drop");
    expect(drop("Clients")).toBe("over");
    expect(drop("Receipts 2026")).toBe("ready");
    expect(drop("Archive")).toBeNull();
    cleanup();
    draw(<Rail said={fresh()} />);
    expect(document.querySelectorAll("[data-drop]")).toHaveLength(0);
  });

  it("speaks German", () => {
    draw(<Rail said={fresh()} />, "de");
    expect(screen.getByRole("button", { name: /Alle Ordner/ })).toBeTruthy();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("menuitem", { name: "Anheften" })).toBeTruthy();
  });
});
