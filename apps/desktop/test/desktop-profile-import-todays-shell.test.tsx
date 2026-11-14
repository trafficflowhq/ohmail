import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The source check covers the legacy shell's profile-import notice. The first-run behavior is exercised separately by the desktop profile-import integration tests.

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the wiring, pinned by source", () => {
  const shell = fs.readFileSync(
    path.resolve(APP, "../webapp/app/shell/AppShell.tsx"),
    "utf8",
  );

  it("the shared shell threads the host wire into the one import state", () => {
    expect(shell).toMatch(/const profileImportOffer = useProfileImport\(!demo, facts, profileImportTransport, undefined, profileDoorbell\);/);
  });
});
