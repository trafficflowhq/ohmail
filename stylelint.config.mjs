// The style linter's configuration. `node tools/check.mjs` runs it over the stylesheets of the
// folders tools/new-tree.txt lists and reads the findings against tools/baseline.tsv.

// Every class of the kit carries this prefix, and the app styles no class that does.
export const KIT_PREFIX = "oh-";

// A value is a token, or one of the few words that are no value of their own.
const WORD = "(var\\(--[a-zA-Z0-9-]+\\)|0|auto|inherit|none|transparent|currentColor)";
const TOKEN_ONLY = [`/^${WORD}(\\s*[ /,]\\s*${WORD})*$/`];

const TOKEN_PROPERTIES = [
  // colour
  "color",
  "background-color",
  "/^border(-[a-z]+)*-color$/",
  "outline-color",
  "fill",
  "stroke",
  "caret-color",
  "accent-color",
  "text-decoration-color",
  // size and weight
  "font-size",
  "font-weight",
  // gap
  "gap",
  "row-gap",
  "column-gap",
  "/^padding/",
  "/^margin/",
  // radius, shadow, duration, layer
  "/^border(-[a-z]+)*-radius$/",
  "box-shadow",
  "text-shadow",
  "/^(transition|animation)-(duration|delay)$/",
  "z-index",
];

const tokenOnly = {
  "declaration-property-value-allowed-list": Object.fromEntries(
    TOKEN_PROPERTIES.map((property) => [property, TOKEN_ONLY]),
  ),
  // A literal colour or a literal time is refused inside a shorthand too.
  "color-no-hex": true,
  "color-named": "never",
  "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"],
  "declaration-property-unit-disallowed-list": { "/^(transition|animation)$/": ["s", "ms"] },
};

export default {
  rules: {
    // No rule is switched off from inside a stylesheet.
    "comment-word-disallowed-list": ["/^\\s*stylelint-/"],
  },
  overrides: [
    // The tokens are where the values live: the token rules do not bind them.
    {
      files: ["packages/ui/**/*.css", "packages/app/**/*.css", "apps/paired-page/**/*.css"],
      rules: tokenOnly,
    },
    {
      // The kit: every class carries the prefix, and no bare element is styled.
      files: ["packages/ui/**/*.css"],
      rules: { "selector-class-pattern": `^${KIT_PREFIX}[a-z0-9]+(-[a-z0-9]+)*$`, "selector-max-type": 0 },
    },
    {
      // A feature places kit parts; it never restyles one, and it writes no width.
      files: ["packages/app/**/*.css"],
      rules: {
        "selector-disallowed-list": [`/\\.${KIT_PREFIX}/`],
        "selector-max-type": 0,
        "media-feature-name-disallowed-list": ["/^(min-|max-)?(device-)?width$/"],
      },
    },
  ],
};
