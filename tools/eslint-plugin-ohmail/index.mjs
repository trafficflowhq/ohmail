// The repository's own lint rules. Plain modules, imported by path from eslint.config.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { importVisitor } from "./imports.mjs";
import { borderRefusal, declaredVerdict, loadWorkspace } from "./workspace.mjs";

const workspaces = new Map();
function workspaceOf(context) {
  const root = context.options[0]?.root ?? context.cwd;
  if (!workspaces.has(root)) workspaces.set(root, loadWorkspace(root));
  return workspaces.get(root);
}
const rootOption = [
  { type: "object", properties: { root: { type: "string" } }, additionalProperties: false },
];

/** The import borders: a file imports only what its folder's row of tools/borders.json names. */
const packageBorders = {
  meta: {
    type: "problem",
    schema: rootOption,
    messages: {
      refused: "{{why}} (border: {{reach}})",
      noRow: "{{folder}} has no row in tools/borders.json: add its row before its first file",
    },
  },
  create(context) {
    const workspace = workspaceOf(context);
    const { unit } = workspace.classify(context.filename);
    if (!unit.row) {
      return {
        Program: (node) => context.report({ node, messageId: "noRow", data: { folder: unit.folder } }),
      };
    }
    return importVisitor(({ node, source, typeOnly }) => {
      const refused = borderRefusal(workspace, context.filename, source, { typeOnly });
      if (refused) context.report({ node, messageId: "refused", data: refused });
    });
  },
};

/** A file imports only what its manifest declares: hoisting lets an undeclared import resolve by accident. */
const declaredDependency = {
  meta: { type: "problem", schema: rootOption, messages: { undeclared: "{{why}}" } },
  create(context) {
    const workspace = workspaceOf(context);
    return importVisitor(({ node, source, typeOnly }) => {
      const why = declaredVerdict(workspace, context.filename, source, { typeOnly });
      if (why) context.report({ node, messageId: "undeclared", data: { why } });
    });
  },
};

/** `@acme` names `@acme/edge`; `acme` names `acme` and `acme/edge`, never `acmeish`. */
export const isPlatformPackage = (source, platforms) =>
  platforms.some((p) => (p.packages ?? []).some((name) => source === name || source.startsWith(`${name}/`)));

/** `ACME_` names `ACME_REGION`: the prefix, then capitals, digits and underscores. */
export const isPlatformName = (text, platforms) =>
  /^[A-Z0-9_]+$/.test(text) &&
  platforms.some((p) =>
    (p.names ?? []).some((prefix) => text.length > prefix.length && text.startsWith(prefix)),
  );

/** A door entry is a file, or a folder written `folder/**`. */
export function isDoorFile(rel, doors) {
  return doors.some((entry) => (entry.endsWith("/**") ? rel.startsWith(entry.slice(0, -2)) : rel === entry));
}

/**
 * The hosting stays movable: a platform's own package or environment name stands only in a door file. The
 * options are tools/doors.json's two lists: the platforms (their packages and the prefixes of their
 * environment names) and the door files. Without either, every file is refused, never none.
 */
const platformName = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          doors: { type: "array", items: { type: "string" } },
          platforms: { type: "array", items: { type: "object" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      name: "{{name}} is a hosting platform's own name; it stands only in a door file (tools/doors.json)",
      noDoors:
        "the platform rule has no list of door files or no platform to look for (tools/doors.json), so every file is refused",
    },
  },
  create(context) {
    const { doors, platforms } = context.options[0] ?? {};
    const looksFor = (platforms ?? []).some((p) => p.packages?.length || p.names?.length);
    if (!Array.isArray(doors) || doors.length === 0 || !looksFor) {
      return { Program: (node) => context.report({ node, messageId: "noDoors" }) };
    }
    const root = context.options[0]?.root ?? context.cwd;
    const rel = path.relative(root, context.filename).split(path.sep).join("/");
    if (isDoorFile(rel, doors)) return {};
    const name = (node, text) => {
      if (typeof text === "string" && isPlatformName(text, platforms))
        context.report({ node, messageId: "name", data: { name: text } });
    };
    const key = (node) => !node.computed && node.key?.type === "Identifier" && name(node.key, node.key.name);
    return {
      ...importVisitor(({ node, source }) => {
        if (isPlatformPackage(source, platforms))
          context.report({ node, messageId: "name", data: { name: source } });
      }),
      MemberExpression: (node) =>
        !node.computed && node.property.type === "Identifier" && name(node.property, node.property.name),
      Property: key,
      PropertyDefinition: key,
      TSPropertySignature: key,
      Literal: (node) => name(node, node.value),
      TemplateLiteral: (node) => node.expressions.length === 0 && name(node, node.quasis[0].value.cooked),
    };
  },
};

const isTypeDeclaration = (node) =>
  node?.type === "TSInterfaceDeclaration" || node?.type === "TSTypeAliasDeclaration";

/** `packages/wire` is types only: it adds no byte to any bundle. */
const wireExportsNoValue = {
  meta: { type: "problem", schema: [], messages: { value: "wire exports no value: {{what}}" } },
  create(context) {
    const refuse = (node, what) => context.report({ node, messageId: "value", data: { what } });
    return {
      ExportDefaultDeclaration: (node) => refuse(node, "a default export is a value"),
      TSExportAssignment: (node) => refuse(node, "`export =` is a value"),
      ExportAllDeclaration: (node) =>
        node.exportKind !== "type" && refuse(node, "write `export type * from`"),
      ExportNamedDeclaration(node) {
        if (node.exportKind === "type" || isTypeDeclaration(node.declaration)) return;
        if (node.declaration) return refuse(node, "only `type` and `interface` are exported");
        if (node.specifiers.some((specifier) => specifier.exportKind !== "type"))
          refuse(node, "write `export type { … }`");
      },
    };
  },
};

/** No rule is switched off from inside a file. */
const noInlineConfig = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      inline: "a lint rule is not switched off in a file; a waiver is a ruling named in the change's message",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          // `/* eslint rule: off */` configures a rule only as a block comment; in a line it is prose.
          const switchesOff =
            comment.type === "Block" ? /^\s*eslint(-disable|-enable|\s)/ : /^\s*eslint-disable/;
          if (switchesOff.test(comment.value)) context.report({ loc: comment.loc, messageId: "inline" });
        }
      },
    };
  },
};

/**
 * No comment sets a rule: `/* eslint rule: off *\/`. The check runs this rule by itself with such comments
 * unread (tools/lib/findings.mjs), since a comment could set this rule too; it binds every file.
 */
const noConfigComment = {
  meta: {
    type: "problem",
    schema: [],
    messages: { set: "a comment does not set a lint rule; the rules are set in eslint.config.mjs" },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Block" && /^\s*eslint\s/.test(comment.value))
            context.report({ loc: comment.loc, messageId: "set" });
        }
      },
    };
  },
};

/** tools/doors.json as the platform rule's options: the door files, and the platforms to look for. */
export function readDoors(root) {
  try {
    const { doors, platforms } = JSON.parse(readFileSync(path.join(root, "tools/doors.json"), "utf8"));
    return { doors: doors.flatMap((door) => [...door.files, ...(door.tests ?? [])]), platforms };
  } catch {
    return { doors: [], platforms: [] }; // the rule then refuses every file
  }
}

export default {
  meta: { name: "eslint-plugin-ohmail" },
  rules: {
    "package-borders": packageBorders,
    "declared-dependency": declaredDependency,
    "platform-name": platformName,
    "wire-exports-no-value": wireExportsNoValue,
    "no-inline-config": noInlineConfig,
    "no-config-comment": noConfigComment,
  },
};
