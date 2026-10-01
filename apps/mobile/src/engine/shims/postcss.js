/**
 * THE CSS PARSER, REFUSED — imported at module scope by sanitize-html, reached only for a `style`
 * attribute the sanitizing policy allows.
 *
 * The engine's one policy (`packages/services/src/outbound-html.ts`) allows `a[href]` alone, so
 * no `style` attribute reaches the parser. If a policy ever allows one, this throw lands in
 * sanitize-html's own catch around the parse, which removes the attribute: the result fails
 * closed rather than passing unparsed CSS.
 */
"use strict";

function parse() {
  throw new Error("CSS parsing is not available in this app's mail engine");
}

module.exports = { parse };
