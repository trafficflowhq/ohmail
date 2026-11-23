import ts from "typescript";

/** Read only a MailRow's own swipe prop, even when another prop contains JSX. */
export function mailRowSwipes(source: string): Array<"off" | "on" | "assigned" | "unknown"> {
  const tree = ts.createSourceFile("Screen.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const swipes: Array<"off" | "on" | "assigned" | "unknown"> = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(tree) === "MailRow") {
      const props = node.attributes.properties;
      if (props.some(ts.isJsxSpreadAttribute)) {
        swipes.push("unknown");
      } else {
        const swipe = props.filter(ts.isJsxAttribute).find((prop) => prop.name.getText(tree) === "swipe");
        swipes.push(swipe === undefined ? "off" : swipe.initializer === undefined ? "on" : "assigned");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return swipes;
}
