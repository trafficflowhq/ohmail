# Contributing

ohmail is built by a small team at [TrafficFlow GmbH](https://trafficflow.ch) in
Zürich. This repository is the free desktop client — one application on macOS,
Windows and Linux. Contributions are welcome, and so is a plain "this is wrong" —
the client is early enough that direction still moves.

## What is most useful right now

Every build now connects to a real mailbox
([status](README.md#status--read-this-first)), so the most valuable input is
about how it behaves against real mail:

- **Design and interaction** — the Blanc surfaces, keyboard flow, compact
  (≤ 390 px) layout, reduced-motion behaviour, screen-reader gaps.
- **The shell's security posture** — the CSP, the empty capability list, the
  offline guard, the aliases in `apps/desktop/vite.config.ts`. A way for the app
  to reach the network that we have missed is the most valuable bug in the
  repository.
- **The engine seam** — the window talks to the engine over a private pipe and
  nothing else. If you find a path around it, that is worth reporting even if
  nothing breaks yet.
- **Correctness of the honest claims** — if the README or
  `apps/desktop/README.md` overstates something, that is a bug too, and a
  serious one.

Please do not send IMAP or sync implementations unprompted. That layer has a
design (rules-first pipeline, desired-state folder moves, redacted handling of
sensitive mail) that is not published yet, and a large PR against it would be
wasted work. Open an issue first and we will tell you what is planned.

## Issues

Issues are welcome and read. Useful bug reports carry: your OS version, the
toolchain version (`rustc --version` and `node --version`), what you ran, what
happened, what you expected. If it is visual, a screenshot beats a description.

## Pull requests

- Fork, branch, open a PR against `main`. PRs are reviewed by a human.
- CI runs four jobs — macOS, Windows, Linux and the engine. Each platform job
  runs `tsc`, builds the UI bundle, smokes it, runs `cargo test` in both
  configurations, builds the engine and its runtime, packages the app, and then
  opens the artifact it just built to check the engine is inside and starts. The
  engine job typechecks and bundles the engine source on its own. All must pass;
  the smoke is what catches a view that lays out but draws nothing, and the
  artifact inspection is what catches a build that grew a network call.
- Keep the existing invariants: colours and shadows come from `packages/tokens`,
  never hand-written in a view; no message is ever replaced by a "N more"
  placeholder. The test suite enforces both, and it is meant to.
- Add or extend a test for behaviour you change.
- Match the surrounding style. There is no formatter config to fight with.

## Sign your commits (DCO) — and no CLA

**There is no contributor licence agreement and no copyright assignment.** You
keep your copyright. We will never ask you to sign your rights over to a Swiss
company in exchange for having a patch merged.

What we do ask for is the [Developer Certificate of Origin][dco] 1.1 — the same
lightweight sign-off the Linux kernel uses. It is one line per commit, and it
says you wrote the patch or otherwise have the right to send it:

```bash
git commit -s -m "fix: the Screener's compact drawer keeps focus"
```

`-s` appends the trailer, using your `user.name` and `user.email` from git:

```
Signed-off-by: Jane Hacker <jane@example.com>
```

Use a real name and a real address you read. Forgot on a commit you already
made? `git commit -s --amend` for the last one, or
`git rebase --signoff main` for a whole branch, then force-push.

### The DCO, in full

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same license (unless I am permitted to submit
    under a different license), as indicated in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Sign-off is checked by a human at review time, not by a bot. We deliberately did
not add a CI gate for it: the commits on `main` are machine-generated syncs from
the private monorepo and carry no trailer, so a check that ran on pushes would
sit permanently red and teach everyone to ignore a red build. If that ever
changes, the safe shape is a job scoped to `pull_request` only. Until then, if
you forget, we will just ask.

### What your contribution is licensed as, and what that means for us

Your contribution is licensed under **GPL-3.0-or-later**, the same as the rest
of this repository. Nothing more is asked, and nothing more is taken.

The honest consequence, which most projects leave you to work out yourself:
because you keep your copyright and grant only the GPL, **TrafficFlow cannot
move your code into ohmail Cloud**, which is closed-source. For almost
everything here that is a non-issue — `apps/desktop` is the desktop client and
exists nowhere else.

There is one real exception, and you should know about it before you spend a
weekend on a patch. These trees are **shared with the Cloud web client**:

- `packages/tokens`, `packages/ui`, `packages/fixtures`
- `packages/client-engine`
- `apps/webapp/app/{shell,views}`

They are published here under GPL-3.0 and used in the proprietary Cloud client,
which TrafficFlow can do because it holds the copyright on all of it
([COPYRIGHT](COPYRIGHT)). A contribution from you into one of those files would
break that arrangement — we would be unable to ship it on the Cloud side without
your separate permission.

So, for a PR touching those paths, one of three things happens, and we will tell
you which at review time rather than sitting on it:

1. **It is a bug fix or a small change** — we merge it and live with it. This is
   the usual outcome.
2. **We ask** whether you are willing to also license that specific patch to
   TrafficFlow for the Cloud client. You may say no, and "no" is a complete
   answer that costs you nothing.
3. **We reimplement it** if neither of the above works. You get the credit for
   the report and the design; we write the code.

If you want to avoid the question entirely, contribute to `apps/desktop`.
And if a large change is forming in your head, open an issue
first — that is true for the whole repository, and doubly so here.

[dco]: https://developercertificate.org/

## Conduct

Be direct, be technical, be decent. Harassment or discrimination gets you
removed from the repository, and there is no appeal process.

## Contact

Anything that does not belong in a public issue: **support@ohmail.app**.
Security reports go the way [SECURITY.md](SECURITY.md) describes — not into an
issue.
