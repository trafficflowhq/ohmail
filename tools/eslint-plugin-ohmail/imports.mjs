// Every way a module names another one, as one visitor: `import`, `export … from`, `import()`,
// `require()`, `import x = require()` and the type `import("x")`.

const literal = (node) => (node?.type === "Literal" && typeof node.value === "string" ? node.value : null);
const templateText = (node) =>
  node?.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;

/**
 * @param {(found: { node: object, source: string, typeOnly: boolean }) => void} report
 * @returns {Record<string, (node: any) => void>} an ESLint visitor
 */
export function importVisitor(report) {
  const found = (node, sourceNode, typeOnly) => {
    const source = literal(sourceNode) ?? templateText(sourceNode);
    if (source) report({ node: sourceNode, source, typeOnly });
  };
  return {
    ImportDeclaration: (node) => found(node, node.source, node.importKind === "type"),
    ExportNamedDeclaration: (node) => node.source && found(node, node.source, node.exportKind === "type"),
    ExportAllDeclaration: (node) => found(node, node.source, node.exportKind === "type"),
    ImportExpression: (node) => found(node, node.source, false),
    TSImportType: (node) => found(node, node.argument?.literal ?? node.argument, true),
    TSImportEqualsDeclaration: (node) =>
      node.moduleReference.type === "TSExternalModuleReference" &&
      found(node, node.moduleReference.expression, node.importKind === "type"),
    CallExpression: (node) =>
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments.length === 1 &&
      found(node, node.arguments[0], false),
  };
}
