// The three tools, each run through its Node API and read into one shape: a finding is one
// violation of one rule in one file.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CONFIG = "eslint.config.mjs";
const rel = (root, file) => path.relative(root, file).split(path.sep).join("/");

export const isSource = (file) => SOURCE.test(file);

/** The linter's one configuration file. Its own lookup would take an `eslint.config.js` first. */
export const linterConfig = (root) => path.join(root, CONFIG);

/** @param {string[]} rootEntries the names in the repository's root */
export function otherLinterConfigs(rootEntries) {
  return rootEntries
    .filter((name) => /^eslint\.config\.[cm]?[jt]s$/.test(name) && name !== CONFIG)
    .sort()
    .map((name) => `config: ${name} stands beside ${CONFIG}; the linter has one configuration file`);
}

// A switch-off comment that switches nothing off: its rule reported nothing, or is not installed.
const INERT_DIRECTIVE = /^(Unused eslint-disable directive|Definition for rule .* was not found)/;

function eslintRule(message) {
  if (INERT_DIRECTIVE.test(message.message)) return "eslint:unused-directive";
  if (message.ruleId) return message.ruleId;
  return message.fatal ? "eslint:parse" : "eslint:config";
}

// The border rule ends its message with the package the import reached: a row is kept per package.
const REACHED = / \(border: ([^)]+)\)$/;

function finding(root, result, message) {
  const reached = message.ruleId === "ohmail/package-borders" && REACHED.exec(message.message);
  return {
    path: rel(root, result.filePath),
    rule: eslintRule(message),
    ...(reached ? { reach: reached[1] } : {}),
    line: message.line ?? 1,
    message: message.message.replace(REACHED, ""),
  };
}

/**
 * A comment switches nothing off: a finding that an `eslint-disable` comment suppressed is a finding all
 * the same, and a comment that sets a rule is one too.
 * @returns {Promise<{ path: string, rule: string, reach?: string, line: number, message: string }[]>}
 */
export async function runEslint(root, files, { concurrency = "off" } = {}) {
  if (files.length === 0) return [];
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: linterConfig(root),
    concurrency,
    warnIgnored: false,
    errorOnUnmatchedPattern: false,
  });
  const results = await eslint.lintFiles(files);
  const found = results.flatMap((result) =>
    [...result.messages, ...result.suppressedMessages].map((message) => finding(root, result, message)),
  );
  return [...found, ...(await configComments(root, files))];
}

export const CONFIG_COMMENT_RULE = "ohmail/no-config-comment";
const MAY_SET_A_RULE = /\/\*\s*eslint\s/;

/**
 * `/* eslint rule: off *\/` would switch off any rule of the configuration, the one against such comments
 * too. So that rule runs here by itself, with comments unread, on the files whose text could hold one.
 */
async function configComments(root, files) {
  const candidates = files.filter((file) => MAY_SET_A_RULE.test(readFileSync(file, "utf8")));
  if (candidates.length === 0) return [];
  const [{ ESLint }, { default: tseslint }, { default: ohmail }] = await Promise.all([
    import("eslint"),
    import("typescript-eslint"),
    import("../eslint-plugin-ohmail/index.mjs"),
  ]);
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    allowInlineConfig: false,
    warnIgnored: false,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
          sourceType: "module",
        },
        plugins: { ohmail },
        rules: { [CONFIG_COMMENT_RULE]: "error" },
      },
    ],
  });
  const results = await eslint.lintFiles(candidates);
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === CONFIG_COMMENT_RULE)
      .map((message) => finding(root, result, message)),
  );
}

export async function runStylelint(root, files) {
  if (files.length === 0) return [];
  const { default: stylelint } = await import("stylelint");
  const { results } = await stylelint.lint({
    files,
    cwd: root,
    configFile: path.join(root, "stylelint.config.mjs"),
    allowEmptyInput: true,
  });
  return results.flatMap((result) => [
    ...result.warnings.map((w) => ({
      path: rel(root, result.source),
      rule: `stylelint:${w.rule}`,
      line: w.line ?? 1,
      message: w.text,
    })),
    ...(result.parseErrors ?? []).map((e) => ({
      path: rel(root, result.source),
      rule: "stylelint:parse",
      line: e.line ?? 1,
      message: e.text,
    })),
  ]);
}

export async function runPrettier(root, files) {
  if (files.length === 0) return [];
  const prettier = await import("prettier");
  const options =
    (await prettier.resolveConfig(path.join(root, "package.json"), {
      config: path.join(root, ".prettierrc.json"),
    })) ?? {};
  const findings = [];
  for (const file of files) {
    const info = await prettier.getFileInfo(file);
    if (!info.inferredParser) continue;
    const formatted = await prettier.check(readFileSync(file, "utf8"), { ...options, filepath: file });
    if (!formatted)
      findings.push({
        path: rel(root, file),
        rule: "prettier",
        line: 1,
        message: "not formatted: run `npm run format`",
      });
  }
  return findings;
}

/** Formats `files` in place; @returns the paths it changed. */
export async function formatFiles(root, files) {
  const prettier = await import("prettier");
  const options =
    (await prettier.resolveConfig(path.join(root, "package.json"), {
      config: path.join(root, ".prettierrc.json"),
    })) ?? {};
  const changed = [];
  for (const file of files) {
    const info = await prettier.getFileInfo(file);
    if (!info.inferredParser) continue;
    const text = readFileSync(file, "utf8");
    const formatted = await prettier.format(text, { ...options, filepath: file });
    if (formatted === text) continue;
    writeFileSync(file, formatted);
    changed.push(rel(root, file));
  }
  return changed;
}
