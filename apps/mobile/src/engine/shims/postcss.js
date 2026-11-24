/**
 * THE CSS PARSER, REFUSED — imported at module scope by sanitize-html, reached only for a `style`
 * attribute the sanitizing policy allows.
 *
 * The outbound policy admits fixed style values by exact match with CSS parsing disabled.
 * If parsing is enabled, sanitize-html catches this error and drops the attribute.
 */
"use strict";

function parse() {
  throw new Error("CSS parsing is not available in this app's mail engine");
}

module.exports = { parse };
