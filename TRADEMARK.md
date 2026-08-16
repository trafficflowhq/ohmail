# Trademark policy

ohmail is free software. The ohmail **marks** are not part of that grant.

The product is written **ohmail** — lower-case, and in rendered artwork with a
terracotta period after it: *ohmail.* That is how the name is used and how it is
claimed. Casing is presentation, not identity: the assertions below cover the
word however it is capitalised, so "OhMail", "Ohmail" and "OHMAIL" are the same
mark and are equally not licensed here.

Copyright, patent and trademark are three different things, and the AGPL is
explicit about the difference: section 7(e) of AGPL-3.0 permits a licence to
decline to grant rights under trademark law. This document is that declination,
and nothing more — it takes away no freedom the AGPL gives you over the *code*.

## What is not licensed under the AGPL

| Mark | Where it appears in this tree |
|---|---|
| the name **ohmail**, in any casing | throughout — the product name, the macOS bundle `ohmail.app`, `ohmail.exe`, `/usr/bin/ohmail`, the Debian package `ohmail` |
| the **"oh." wordmark** | drawn into the icon artwork below |
| the **app icon** — the "oh." squircle tile | `Resources/ohmail.icns`, `docs/ohmail-icon.png`, `apps/desktop/src-tauri/icons/` (`icon.icns`, `icon.ico`, `icon.png`, `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`) |
| the domains **ohmail.app** and **app.ohmail.app** | links in the README and in the app's own about screen |

These are trademarks of **TrafficFlow GmbH**, Staubstrasse 1, 8038 Zürich,
Switzerland. They are *included* in this repository because the project builds
with them — not offered under AGPL-3.0.

The image files above are the only binary artwork excluded from the AGPL grant.
The other binaries in this tree — the feature recordings under
`docs/assets/feature-wall/` — are renders of this source tree over its built-in
fictional mailbox and are AGPL-covered along with it; see
[COPYRIGHT](COPYRIGHT). Everything else here is source, and all of that source
is AGPL-3.0.

## What you may do — no permission needed

Everything the AGPL grants, unreduced:

- **Use** ohmail, privately or commercially, for anything.
- **Study and modify** every line, for any purpose.
- **Build** your own binaries from this tree, patched or not, and run them.
- **Redistribute** the source and your changes under AGPL-3.0.
- **Package** ohmail for a distribution and ship it under the ohmail name, *if
  you ship it substantially as we release it* — the ordinary distro-packaging
  case. Patches for build, path and dependency conventions are expected and
  fine; see "Distribution packagers" below.
- **Say what your software is.** "A fork of ohmail", "based on ohmail",
  "compatible with ohmail", "works with ohmail Cloud" are accurate descriptions
  of fact. That is nominative use, it needs no licence, and this policy does not
  restrict it.

## What you must not do

Present something we did not build as though we did.

Concretely, if you distribute a **modified** build to other people:

- Do not call it **ohmail**, or a name a user would confuse with ohmail.
- Do not ship the **"oh." icon or wordmark** as your application's identity.
  Replace `Resources/ohmail.icns` and `apps/desktop/src-tauri/icons/` with your
  own artwork, and change the product name in
  `Resources/Info.plist` and `apps/desktop/src-tauri/tauri.conf.json`.
- Do not use the marks to imply endorsement, affiliation, or that TrafficFlow
  supports your build.

The reason is not control over the code — you have all of it. It is that
**support and reputation follow the name.** A user who installs a fork with our
icon on it, hits a bug your patch introduced, and mails support@ohmail.app is a
user we cannot help and a bug we cannot reproduce. Renaming a fork costs you a
few strings and spares both of us that.

This is the same line Mozilla drew with Firefox/Iceweasel and that Signal draws
today: the code is free, the identity is not.

## Hosting services

The AGPL allows anyone to run this code as a service for other people — that
freedom is real, and this policy does not reduce it. What it withholds is the
name: a hosting service operated by anyone other than TrafficFlow must not
call itself ohmail, use the "oh." icon or wordmark as its identity, or use a
name or domain a user would confuse with ohmail.app. "Built on ohmail" or "a
hosted fork of ohmail", as a statement of fact, is nominative use and needs no
permission.

The reason is the same as for forks: support and reputation follow the name. A
hosted service holds people's mail, keeps their accounts, and answers their
support questions, and the marks are how a user knows which company is
answering for all of that. The one hosted service the ohmail marks name is the
one TrafficFlow runs.

## Distribution packagers

You are welcome, and we would rather you shipped ohmail under its own name than
under a made-up one. Ship it as **ohmail** as long as:

1. it is built from an official release tree, with patches limited to what
   packaging genuinely requires (build flags, paths, dependency and toolchain
   conventions, backported fixes from upstream), and
2. your package points bug reports at your distribution first, so a
   packaging-specific problem does not arrive at our address as a ohmail bug.

If a patch changes behaviour a user would notice, tell us and we will almost
certainly still say yes — we just want to know what is shipping with our name on
it. There is no fee and no agreement to sign.

## The icon's own provenance

The "oh." letterforms were drawn as outlined paths from **Inter** Bold (Inter
4.1, © 2016 The Inter Project Authors, SIL Open Font License 1.1). No font
binary is distributed in this repository — see [COPYRIGHT](COPYRIGHT) for the
full third-party position. The resulting artwork is TrafficFlow's, and it is
that artwork, not the typeface, that this policy covers.

## Asking

If you want to use a ohmail mark in a way this document does not clearly allow —
a review, a comparison, a conference talk, a book, a compatible product, a
distro package with unusual patches — just ask: **support@ohmail.app**. We are a
small company in Zürich and we answer mail. A reasonable request gets a yes.

---

Trademark policy for [ohmail](https://ohmail.app) · TrafficFlow GmbH, Zürich ·
Questions: support@ohmail.app · Code licence: [LICENSE](LICENSE) ·
Copyright and third parties: [COPYRIGHT](COPYRIGHT)
