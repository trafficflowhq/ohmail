// The linter's configuration. `node tools/check.mjs` runs it over the whole tree and reads the
// findings against tools/baseline.tsv; `npm run lint` prints them raw.
//
// Three rules of our own bind every file: the import borders (tools/borders.json), the manifest,
// and the hosting platforms' names (tools/doors.json). The rest binds the new tree only, the
// folders tools/new-tree.txt lists: code that came over from 1.0 is not relinted here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import ohmail, { readDoors } from "./tools/eslint-plugin-ohmail/index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const TESTS = ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"];

const newTree = readFileSync(path.join(root, "tools/new-tree.txt"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const under = (entries, pattern = SOURCE) =>
  entries.map((entry) => (path.extname(entry) ? entry : `${entry}/${pattern}`));
const inNewTree = (...folders) => under(folders.filter((folder) => newTree.includes(folder)));

// Interface code: where a file has at most 400 lines and a function at most 120.
const INTERFACE = inNewTree(
  "packages/app",
  "packages/app-logic",
  "packages/ui",
  "packages/tokens",
  "apps/paired-page",
);
const HOOKS = inNewTree("packages/ui", "packages/app-logic", "packages/app");
const SHARED_BEHAVIOUR = inNewTree("packages/app-logic", "packages/app");

// What only a shell may touch: everything else asks the host contract.
const SHELL_ONLY_GLOBALS = [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "navigator",
  "location",
  "history",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
];

const block = (files, rules, extra = {}) => (files.length ? [{ files, rules, ...extra }] : []);

export default [
  { ignores: ["**/node_modules/**"] },
  {
    files: [SOURCE],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      sourceType: "module",
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { ohmail, "react-hooks": reactHooks, "@typescript-eslint": tseslint.plugin },
    rules: {
      "ohmail/package-borders": ["error", { root }],
      "ohmail/declared-dependency": ["error", { root }],
      "ohmail/platform-name": ["error", { root, ...readDoors(root) }],
    },
  },
  ...block(
    ["packages/wire/**"],
    { "ohmail/wire-exports-no-value": "error" },
    { ignores: [...TESTS, "**/*.config.*"] },
  ),
  ...block(under(newTree), {
    "no-empty": ["error", { allowEmptyCatch: false }],
    "@typescript-eslint/ban-ts-comment": "error",
    "ohmail/no-inline-config": "error",
  }),
  ...block(
    INTERFACE,
    { "max-lines": ["error", { max: 400 }], "max-lines-per-function": ["error", { max: 120 }] },
    { ignores: TESTS },
  ),
  ...block(HOOKS, { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" }),
  ...block(
    SHARED_BEHAVIOUR,
    {
      "no-restricted-globals": [
        "error",
        ...SHELL_ONLY_GLOBALS.map((name) => ({
          name,
          message: "Only a shell touches this; shared code asks the host contract.",
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "next", message: "Shared code imports no web framework." }],
          patterns: [{ group: ["next/*"], message: "Shared code imports no web framework." }],
        },
      ],
    },
    { ignores: TESTS },
  ),
];
