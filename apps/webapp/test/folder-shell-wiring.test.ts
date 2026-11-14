import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("flag-off parity and the number keys — the structural claims, at the source", () => {
  it("the disabled account draws no Folders group or empty wrapper", () => {
    const live = source("packages/app-logic/src/folder/live.ts");
    const seat = source("packages/app/src/folder/RailSeat.tsx");
    const rail = source("packages/app/src/frame/RailHost.tsx");
    expect(live).toMatch(/foldersEnabled \? \{ folders, messages, ready \} : null/);
    expect(seat).toMatch(/const live = useFolderRailLive\(\);[\s\S]*?if \(live === null\) return null;[\s\S]*?<FolderRail/);
    expect(rail).toMatch(/drawn\.map\(\(\{ id, Body \}\) => \(\s*<Body [^>]+\/>\s*\)\)\}\s*<\/Fragment>/);
  });

  it("the Folders group contributes nothing to the number keys", () => {
    const folder = source("packages/app/src/folder/place.ts");
    const chords = source("packages/app/src/frame/chords.tsx");
    expect(folder).toMatch(/rail: null,\s*railGroup: \{ group: "folders", Body: FolderRailSeat \}/);
    expect(chords).toMatch(/if \(place === NONE \|\| place\.rail === null \|\| place\.rail\.group !== group\) continue;/);
  });

  it("the folder entities themselves are gated on the consent answer, not only the group", () => {
    expect(source("packages/app-logic/src/folder/live.ts"))
      .toMatch(/foldersEnabled \? atStamp\(derived, engine\.read\(\)\.list<FolderEntity>\("folder"\)\) : NO_FOLDERS/);
  });

  it("the History lens takes the same consent answer — the partition is flag-gated too", () => {
    const partition = source("packages/app-logic/src/consent/partition.ts");
    expect(partition).toMatch(/consentPartition\(reader, shellConsentOptions\(consent, now, ownAddresses, firstImportDoneAt\)\)/);
    expect(source("packages/app-logic/src/press/consent-options.ts"))
      .toMatch(/return \{[\s\S]{0,1200}foldersEnabled: consent\.foldersEnabled,/);
    expect(partition).toMatch(/consent\.foldersEnabled,\n\s*\],/);
  });
});

describe("search hits route to the folder view only when it can show them", () => {
  it("openTargetFor: a held row targets the folder; an off-mirror row keeps the reader", async () => {
    const { openTargetFor } = await import("@ohmail/app-logic/search/open-target");
    const hit = {
      id: "m1", mailboxId: "mb1", folder: "Projects/Acme",
      from: { name: null, address: "a@x.example" },
    } as never;
    const noScreenerRow = () => null;
    // The callback owns the HOLDS question: null means "the view cannot show it" — the exact
    // archive-only case (GET /search reaching past this device's mirror window).
    const offMirror = openTargetFor(hit, false, noScreenerRow, undefined, undefined, undefined, () => null);
    expect(offMirror).toEqual({ kind: "reader", id: "m1" });
    const held = openTargetFor(hit, false, noScreenerRow, undefined, undefined, undefined, () => "fd1");
    expect(held).toEqual({ kind: "folder", folderId: "fd1", id: "m1" });
  });

  it("the shell's callback asks the PRESENTED mirror — pinned at the source", () => {
    const live = source("packages/app-logic/src/search/live-open.ts");
    expect(live).toMatch(/const \{ presented, foldersEnabled \} = ground;/);
    expect(live).toMatch(/return presented\.get<EngineMessage>\("message", m\.id\)\?\.folder === folder \? f\.id : null;/);
    expect(live).toMatch(/folderTargetFor: folderOf\(ground\)/);
  });
});
