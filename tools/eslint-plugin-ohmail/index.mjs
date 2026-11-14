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

/**
 * WHO MAY LOOK UP WHOSE STORAGE THIS IS. The storage owner's readers and setters, the session's marker's readers and
 * the web session client's answers of the account it speaks for are a host's own: a host names the storage owner for
 * its window and reads back what it named (on the desktop the session client is a stub that answers nobody). Anything
 * drawn under a frame takes its scope as an argument from its mount. A product file imports none of these names, under
 * any local name, by any specifier that reaches their modules, makes no namespace import, whole re-export, dynamic
 * import or require of any of those modules, unless tools/owner-readers.json lists it with its reason; a listed file
 * that imports none of them leaves the list, so the list only shrinks. A listed file reads them itself: an export that
 * hands one it imported straight on (the lookup under any name, as the default too, or a function whose whole body
 * returns one call of it) would hand it to every file that imports it from there, and is refused unless that export
 * stands in this table itself. Helpers are not followed: an unexported function that calls a lookup for an export is
 * intent, which a review reads. The marker's cookie name itself is a lookup too: a string, a template or a regular
 * expression that spells it stands only in a listed file, or in a file listed to spell it and nothing more, so the
 * marker cannot be read by hand out of the jar. The same data closes the list of parts that read the shell's scope
 * (`useTodaysScope`).
 */
export const OWNER_LOOKUPS = {
  "storage-owner": [
    "storageOwner",
    "storageOwnerState",
    "setStorageOwner",
    "setDemoStorage",
    "resetStorageOwnerForTest",
  ],
  "owner-cookie": ["readOwner", "readOwnerMarker", "readOwnerCookie", "OWNER_COOKIE"],
  "session-client": ["boundApiOwner", "apiOwnerBinding"],
};
/** The session's marker's cookie name, as the marker's own module spells it (`OWNER_COOKIE`; a case holds them equal). */
export const OWNER_MARKER_NAME = "tf_owner";
const OWNER_DOOR = "packages/app-logic/src/storage";
const OWNER_PACKAGE = "@ohmail/app-logic/storage";
/** The web session client, by its path and by the web app's own alias (`@/`). */
const SESSION_CLIENT = "apps/webapp/app/api-client";
const SESSION_CLIENT_ALIAS = "@/app/api-client";
const TODAYS_SCOPE = "apps/webapp/app/shell/todays-scope";
/** A specifier as it is compared: a folder written with a slash at its end reaches its index, and no extension. */
const withoutExtension = (spec) => spec.replace(/\/+$/, "").replace(/\.(js|ts|tsx|mjs|mts)$/, "");
/** The path a relative specifier reaches from a file, from the root, with no slash at its end. */
const reached = (fromRel, bare) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), bare)).replace(/\/+$/, "");

/**
 * Which module a specifier reaches from a file (paths from the root): one of the three, the storage door (the storage
 * owner's and the marker's both), or none.
 */
export function ownerModuleOf(source, fromRel) {
  const bare = withoutExtension(source);
  if (bare === OWNER_PACKAGE || bare === `${OWNER_PACKAGE}/index`) return "door";
  if (bare === `${OWNER_PACKAGE}/storage-owner`) return "storage-owner";
  if (bare === `${OWNER_PACKAGE}/owner-cookie`) return "owner-cookie";
  if (bare === SESSION_CLIENT_ALIAS) return "session-client";
  if (!source.startsWith(".")) return null;
  const target = reached(fromRel, bare);
  if (target === OWNER_DOOR || target === `${OWNER_DOOR}/index`) return "door";
  if (target === `${OWNER_DOOR}/storage-owner`) return "storage-owner";
  if (target === `${OWNER_DOOR}/owner-cookie`) return "owner-cookie";
  if (target === SESSION_CLIENT) return "session-client";
  return null;
}

/** Whether a specifier reaches the shell's scope (`todays-scope`), by path or by the web app's own alias. */
export function reachesTodaysScope(source, fromRel) {
  const bare = withoutExtension(source);
  if (bare === "@/app/shell/todays-scope") return true;
  if (!source.startsWith(".")) return false;
  return reached(fromRel, bare) === TODAYS_SCOPE;
}

const namesOf = (module) =>
  module === "door"
    ? [...OWNER_LOOKUPS["storage-owner"], ...OWNER_LOOKUPS["owner-cookie"]]
    : OWNER_LOOKUPS[module];
const literalSource = (node) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? node.quasis[0].value.cooked
      : null;
/** An expression as it runs: a type's assertion and an optional chain change no value. */
const SEE_THROUGH = [
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
];
const asRun = (node) => (node && SEE_THROUGH.includes(node.type) ? asRun(node.expression) : node);
const FUNCTIONS = ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"];
/** What a function's whole body returns, when its body is that one value; otherwise null. */
function onlyReturn(fn) {
  if (fn.body.type !== "BlockStatement") return fn.body;
  const [statement, ...more] = fn.body.body;
  return more.length === 0 && statement?.type === "ReturnStatement" ? statement.argument : null;
}
/** The name an export specifier gives, whether it is written as a name or as a string. */
const nameOf = (node) => (node.type === "Identifier" ? node.name : node.value);

const ownerLookup = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          readers: { type: "array", items: { type: "string" } },
          todaysScopeReaders: { type: "array", items: { type: "string" } },
          markerNameSpellers: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      lookup:
        "{{name}} reads the storage owner or the session's marker, a host's own; take the scope as an argument from the mount (tools/owner-readers.json lists the hosts' files)",
      whole:
        "{{what}} of {{source}} reaches the storage owner's or the session's marker's readers, a host's own (tools/owner-readers.json lists the hosts' files)",
      spelled:
        "{{name}} is the session's marker's cookie name: only a host's file spells it; take the scope as an argument from the mount (tools/owner-readers.json lists the hosts' files)",
      handedOn:
        "{{name}} is a host's own lookup, and an export hands it to every file that imports it from here; a host reads it itself (tools/owner-readers.json)",
      stale: "{{file}} is listed in tools/owner-readers.json and imports none of them; it leaves the list",
      staleSpeller:
        "{{file}} is listed in tools/owner-readers.json to spell the marker's cookie name and spells it nowhere; it leaves the list",
      todaysScope:
        "useTodaysScope is read by the closed list in tools/owner-readers.json; a place reads useFrame().host.session.scope",
      noList:
        "ohmail/owner-lookup has no list of readers (tools/owner-readers.json), so every file is refused",
    },
  },
  create(context) {
    const { readers, todaysScopeReaders, markerNameSpellers = [] } = context.options[0] ?? {};
    if (!Array.isArray(readers) || readers.length === 0 || !Array.isArray(todaysScopeReaders)) {
      return { Program: (node) => context.report({ node, messageId: "noList" }) };
    }
    const root = context.options[0]?.root ?? context.cwd;
    const rel = path.relative(root, context.filename).split(path.sep).join("/");
    const mayLookUp = readers.includes(rel);
    const mayReadScope = todaysScopeReaders.includes(rel);
    const maySpell = markerNameSpellers.includes(rel);
    /* Where this file is one of the lookups' own modules, the names it stands for in the table are its to export. */
    const ownModule = ownerModuleOf(`./${path.posix.basename(rel)}`, rel);
    const own = new Set(ownModule === null ? [] : namesOf(ownModule));
    let looked = 0;
    let readScope = 0;
    let spelledHere = 0;
    /*
     * What this file calls the lookups it imported (a namespace of their module, with the module), and what it
     * exports: checked against each other at the end, once every import is read.
     */
    const lookupLocals = new Set();
    const namespaces = new Map();
    const exportedLocals = [];
    const exportedValues = [];
    /** The lookup an expression names as it runs: a lookup's local, or a lookup read off a namespace of its module. */
    const lookupNamed = (node) => {
      const value = asRun(node);
      if (value?.type === "Identifier") return lookupLocals.has(value.name) ? value.name : null;
      if (value?.type !== "MemberExpression" || value.object.type !== "Identifier") return null;
      const module = namespaces.get(value.object.name);
      const name = value.computed ? literalSource(value.property) : value.property.name;
      return module !== undefined && namesOf(module).includes(name) ? name : null;
    };
    /** The lookup a value hands on straight: the lookup itself, or a function whose whole body returns one call of it. */
    const handsOn = (node) => {
      const value = asRun(node);
      if (!FUNCTIONS.includes(value?.type)) return lookupNamed(value);
      const returned = asRun(onlyReturn(value));
      return returned?.type === "CallExpression" ? lookupNamed(returned.callee) : null;
    };
    const handedOn = (node, name) => {
      if (mayLookUp) context.report({ node, messageId: "handedOn", data: { name } });
    };
    const lookup = (node, name) => {
      looked += 1;
      if (!mayLookUp) context.report({ node, messageId: "lookup", data: { name } });
    };
    const whole = (node, what, source) => {
      looked += 1;
      if (!mayLookUp) context.report({ node, messageId: "whole", data: { what, source } });
    };
    const scopeRead = (node) => {
      readScope += 1;
      if (!mayReadScope) context.report({ node, messageId: "todaysScope" });
    };
    const spelled = (node, text) => {
      if (typeof text !== "string" || !text.includes(OWNER_MARKER_NAME)) return;
      looked += 1;
      spelledHere += 1;
      if (!mayLookUp && !maySpell)
        context.report({ node, messageId: "spelled", data: { name: OWNER_MARKER_NAME } });
    };
    const named = (node, source, specifiers, kindOf) => {
      const module = ownerModuleOf(source, rel);
      if (module === null && !reachesTodaysScope(source, rel)) return;
      for (const specifier of specifiers) {
        if (kindOf(specifier) === "type") continue;
        if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ExportNamespaceSpecifier") {
          if (module !== null) whole(specifier, "a namespace", source);
          else scopeRead(specifier);
          if (module !== null && specifier.type === "ImportNamespaceSpecifier") {
            lookupLocals.add(specifier.local.name);
            namespaces.set(specifier.local.name, module);
          }
          continue;
        }
        const from = specifier.type === "ExportSpecifier" ? specifier.local : specifier.imported;
        const name = from?.type === "Identifier" ? from.name : from?.value;
        if (module !== null && namesOf(module).includes(name)) {
          lookup(specifier, name);
          if (specifier.type === "ExportSpecifier") handedOn(specifier, name);
          else lookupLocals.add(specifier.local.name);
        } else if (module === null && name === "useTodaysScope") scopeRead(specifier);
      }
    };
    const wholeModule = (node, what) => {
      const source = literalSource(node);
      if (source === null) return;
      if (ownerModuleOf(source, rel) !== null) whole(node, what, source);
      else if (reachesTodaysScope(source, rel)) scopeRead(node);
    };
    return {
      ImportDeclaration: (node) =>
        node.importKind !== "type" && named(node, node.source.value, node.specifiers, (s) => s.importKind),
      ExportNamedDeclaration: (node) => {
        if (node.exportKind === "type") return;
        if (node.source) return named(node, node.source.value, node.specifiers, (s) => s.exportKind);
        exportedLocals.push(...node.specifiers.filter((s) => s.exportKind !== "type"));
        const declaration = node.declaration;
        if (declaration?.type === "VariableDeclaration")
          for (const { id, init } of declaration.declarations)
            if (id.type === "Identifier" && init)
              exportedValues.push({ at: id, exported: id.name, value: init });
        if (declaration?.type === "FunctionDeclaration" && declaration.id)
          exportedValues.push({ at: declaration.id, exported: declaration.id.name, value: declaration });
      },
      ExportDefaultDeclaration: (node) =>
        exportedValues.push({ at: node, exported: "default", value: node.declaration }),
      ExportAllDeclaration: (node) =>
        node.exportKind !== "type" &&
        wholeModule(node.source, node.exported ? "a namespace" : "a whole re-export"),
      ImportExpression: (node) => wholeModule(node.source, "a dynamic import"),
      CallExpression: (node) =>
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        wholeModule(node.arguments[0], "a require"),
      TSImportEqualsDeclaration: (node) =>
        node.moduleReference.type === "TSExternalModuleReference" &&
        node.importKind !== "type" &&
        wholeModule(node.moduleReference.expression, "an import"),
      Literal: (node) => spelled(node, node.regex ? node.regex.pattern : node.value),
      TemplateElement: (node) => spelled(node, node.value.cooked ?? node.value.raw),
      "Program:exit": (node) => {
        /* The values of the file's own top-level names: `export { whose }` and `export default whose` hand them on. */
        const values = new Map();
        for (const statement of node.body) {
          const declared = statement.declaration ?? statement;
          if (declared?.type === "VariableDeclaration")
            for (const { id, init } of declared.declarations)
              if (id.type === "Identifier" && init) values.set(id.name, init);
          if (declared?.type === "FunctionDeclaration" && declared.id) values.set(declared.id.name, declared);
        }
        const valueOf = (value) =>
          value?.type === "Identifier" && !lookupLocals.has(value.name) && values.has(value.name)
            ? values.get(value.name)
            : value;
        const handOn = (at, exported, value) => {
          const name = own.has(exported) ? null : handsOn(valueOf(value));
          if (name !== null) handedOn(at, name);
        };
        for (const specifier of exportedLocals) {
          const name = nameOf(specifier.local);
          if (lookupLocals.has(name)) handedOn(specifier, name);
          else if (values.has(name)) handOn(specifier, nameOf(specifier.exported), values.get(name));
        }
        for (const { at, exported, value } of exportedValues) handOn(at, exported, value);
        if ((mayLookUp && looked === 0) || (mayReadScope && readScope === 0))
          context.report({ node, messageId: "stale", data: { file: rel } });
        if (maySpell && spelledHere === 0)
          context.report({ node, messageId: "staleSpeller", data: { file: rel } });
      },
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

/**
 * tools/owner-readers.json as the options of `ohmail/owner-lookup`: every host's file, the parts that read the shell's
 * scope, and the files that spell the marker's cookie name and nothing more.
 */
export function readOwnerReaders(root) {
  try {
    const { readers, todaysScopeReaders, markerNameSpellers } = JSON.parse(
      readFileSync(path.join(root, "tools/owner-readers.json"), "utf8"),
    );
    return {
      readers: readers.flatMap((entry) => entry.files),
      todaysScopeReaders: todaysScopeReaders.files,
      markerNameSpellers: markerNameSpellers?.files ?? [],
    };
  } catch {
    return { readers: [], todaysScopeReaders: [], markerNameSpellers: [] }; // the rule then refuses every file
  }
}

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
    "owner-lookup": ownerLookup,
    "wire-exports-no-value": wireExportsNoValue,
    "no-inline-config": noInlineConfig,
    "no-config-comment": noConfigComment,
  },
};
