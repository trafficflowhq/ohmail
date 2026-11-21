import { expect, it } from "vitest";
import { readMounted } from "../../tools/lib/mounted.mjs";

const panes = "packages/app/src/mail/panes.ts";
const contract = "packages/app/src/settings/contract.ts";

function mounted(panesSource: string) {
  const files: Record<string, string> = {
    "packages/app/src/frame/contract.ts": 'export const PLACE_IDS = ["settings"];',
    [contract]: 'export const PANE_IDS = ["account", "folders", "general"];',
    [panes]: panesSource,
  };
  return readMounted({ files: Object.keys(files), textOf: (path) => files[path] ?? null });
}

const sections = [
  "function makePanes() { return { account: accountPane, folders: folderPane }; }",
  "const base = makePanes();",
  "const limited = { ...base, folders: NONE, general: generalPane } as const;",
  "function useAccountPanes() { return useConsent().foldersStorable ? base : limited; }",
  "const selected = parts.folders === NONE ? base : useAccountPanes;",
  "settingsPlace(selected, useBeside);",
].join("\n");

it("reads the static sections and both outcomes of the consent-aware hook", () => {
  const result = mounted(sections);
  expect(result.refusals).toEqual([]);
  expect([...result.mounted].sort()).toEqual(["pane:account", "pane:folders", "pane:general", "settings"]);
});

it("honors a local spread override in the only registered branch", () => {
  const result = mounted(sections.replace("settingsPlace(selected,", "settingsPlace(limited,"));
  expect(result.refusals).toEqual([]);
  expect([...result.mounted].sort()).toEqual(["pane:account", "pane:general", "settings"]);
});

it("refuses a registration when either branch cannot be read", () => {
  const result = mounted(sections.replace("? base : useAccountPanes", "? base : missing"));
  expect(result.refusals).toEqual([
    expect.stringContaining("calls settingsPlace with a record the tool cannot read"),
  ]);
});

it.each([
  ["a short-circuit expression", "choose() && actual"],
  ["a property on a call result", "choose().panes"],
  ["an expression after a literal", "{ account: accountPane } && actual"],
])("refuses %s as the source of Settings panes", (_kind, expression) => {
  const result = mounted(
    [
      "function choose() { return { account: accountPane }; }",
      "const actual = { folders: folderPane };",
      `const registered = ${expression};`,
      "settingsPlace(registered, useBeside);",
    ].join("\n"),
  );
  expect(result.refusals).toEqual([
    expect.stringContaining("calls settingsPlace with a record the tool cannot read"),
  ]);
  expect([...result.mounted]).toEqual([]);
});

it("refuses a hook with return paths it cannot enumerate", () => {
  const result = mounted(
    [
      "function useAccountPanes() {",
      "  if (useConsent().foldersStorable) return { account: accountPane };",
      "  return { folders: folderPane };",
      "}",
      "settingsPlace(useAccountPanes, useBeside);",
    ].join("\n"),
  );
  expect(result.refusals).toEqual([
    expect.stringContaining("calls settingsPlace with a record the tool cannot read"),
  ]);
  expect([...result.mounted]).toEqual([]);
});
