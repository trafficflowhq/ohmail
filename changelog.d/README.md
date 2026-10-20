# changelog.d

Each change waiting for the next release has one file here. A pull request adds its own and never edits
`CHANGELOG.md`, so two pull requests never conflict over the changelog.

## The file

`changelog.d/<slug>.md`, the slug in lower-case letters and digits joined by single dashes (your branch name
is usually right). The file is the entry and nothing else:

```text
### The Screener keeps focus when the drawer closes

One or more paragraphs saying what changed for the person using ohmail, and on which apps
(desktop, web, phone, Cloud, your own server) where that matters.
```

- The first line is `### ` and a headline without a full stop. It becomes one release note, and one line
  in the Flathub listing.
- No other heading anywhere in the file, code blocks included; no `[x]: url` link definitions (write links
  inline); no HTML comments.
- Write relative links from the repository root, as `CHANGELOG.md` reads them: `[the README](README.md)`.
- A value you cannot know yet, such as the day a fix reached ohmail Cloud, may wait as `<date>`, `<version>`
  or `<sha>`. The release refuses to fold it until it is filled.

`node scripts/changelog-fold.mjs --check` checks every file here, and the test suite runs the same check.
`--preview` prints the section the next release would write.

## At the release

The release bump runs `node scripts/changelog-fold.mjs --release <version> --date <YYYY-MM-DD>`. It writes
every file here, in file-name order, under the new version's heading in `CHANGELOG.md`, updates the link
lines and the Flathub metainfo, and deletes the files in the same commit. This README stays.
