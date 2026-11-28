import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({ local: false, cloud: false }));

vi.mock("../src/engine.js", () => {
  loaded.local = true;
  return {};
});

vi.mock("../src/cloud-engine.js", () => {
  loaded.cloud = true;
  return {};
});

it("loads neither desktop engine before the process selects a mode", async () => {
  await import("../src/main.js");
  expect(loaded).toEqual({ local: false, cloud: false });
});
