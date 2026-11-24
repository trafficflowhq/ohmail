import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The source check covers the shared frame's profile-import notice. The first-run behavior is exercised separately by the desktop profile-import integration tests.

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the wiring, pinned by source", () => {
  const shell = fs.readFileSync(
    path.resolve(APP, "../../packages/app/src/profile-import/ground.tsx"),
    "utf8",
  );

  it("the shared shell threads the host wire into the one import state", () => {
    expect(shell).toMatch(/const wire = host\.wires\.profileImport;/);
    expect(shell).toMatch(/const active = !demo && host\.session\.state !== "refused" && wire !== NONE;/);
    expect(shell).toMatch(/const state = useProfileImport\(\s*active,\s*mailboxes,\s*wire === NONE \? null : wire,\s*undefined,\s*settingsDoorbell\(engine\.read\(\)\),\s*engine,\s*\);/);
  });
});
