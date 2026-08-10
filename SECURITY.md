# Security policy

## Reporting a vulnerability

Email **support@ohmail.app** with `SECURITY` in the subject. That address is the
one published on [ohmail.app](https://ohmail.app) and is monitored by the team at
TrafficFlow GmbH; there is no separate security alias yet, and we would rather
say so than publish an address nobody reads.

Please include: what you found, how to reproduce it, the version or commit you
tested, and what you think the impact is. If you have a patch, send it in the
mail rather than opening a PR.

**Do not open a public issue for a vulnerability.** Everything else — crashes,
layout bugs, wrong copy — belongs in an issue.

We will acknowledge within 5 working days, tell you our assessment and a rough
timeline, and credit you in the release notes if you want the credit. We do not
run a bug bounty. We will not threaten you for reporting in good faith.

## Scope

In scope: this repository — the macOS client, the Windows/Linux Tauri shell
(`apps/desktop`, including its CSP, its capability set and the offline guard),
the shared client UI they render, the build and packaging scripts, and the CI
workflow.

Out of scope here, but still worth reporting to the same address:
ohmail.app, app.ohmail.app, and the ohmail Cloud backend. None of that code lives in
this repository.

## ohmail Cloud

The same address, the same commitments, and the same 5-working-day
acknowledgement cover **ohmail.app, app.ohmail.app and the Cloud backend** — the code
is not published, but the disclosure policy is, and reports about it are as
welcome as reports about this repository. Two limits, stated so nobody has to
guess: please do not test against another person's account or mailbox, and
please do not run load or denial-of-service tests against the hosted service.
Cloud mail is encrypted in transit and at rest but is **not** end-to-end
encrypted — the service has to read mail to file and search it. The subprocessor
list and the retention table are published at
<https://ohmail.app/subprocessors>; the conditions under which a human at
TrafficFlow can reach production data are written down in the product privacy
policy, which publishes before the first real mailbox connects.
If personal data is ever breached we notify the competent
authority within 72 hours of becoming aware, and affected people directly where
the risk to them is high.

## What each build does and does not do

Worth knowing before you go looking, because the two builds have very different
threat surfaces right now.

**macOS — the engine-bearing build — connects to your mailbox (and, if you ask it
to, to ohmail Cloud):**

- In **local mode** it opens **one IMAP connection over TLS** to the mail server you
  give it, and — only if you enable it — one connection to your own Anthropic key or a
  local Ollama. Beyond that it makes only the signed update check; there is no telemetry
  and no analytics.
- In **Cloud mode** — an optional sign-in — it connects instead to `api.ohmail.app`, the
  hosted ohmail service, over HTTPS, and acts as a viewer of a mailbox that service already
  organises. It runs no local engine and opens no IMAP connection in this mode. The Cloud
  session is held in memory only and re-established each launch; no mailbox credentials are
  stored on the device.
- The packaging step reads every host string in the shipped binary and **fails the build on
  any host outside an explicit allow-list** — `api.ohmail.app`, the signed update feed, and
  the local-engine pipe — so a telemetry or third-party endpoint cannot ship unremarked.
- **Credentials**: your mail password is sealed under a per-install AES key and is never
  written to disk in the clear. That key is kept in your computer's keystore — the login
  **Keychain** on macOS — **and mirrored to a `0600` file beside the app's data**, because
  an application without a developer certificate is refused its own keystore item as soon
  as its binary changes, which is every update. Where the keystore refuses, the file is the
  only copy: the key is then protected by file permissions rather than by your login
  password, and it sits beside a local mail mirror that is an ordinary unencrypted database.
  Reports about the credential envelope, the key file, the keystore use, or TLS/certificate
  handling are exactly what we want.
- It **renders mail as HTML** and blocks remote content, so the tracking pixels that
  report when and where you opened a message do not load. HTML-rendering and
  remote-content issues are in scope.
- **Sensitive mail** — one-time codes and login links — is structurally excluded
  from anything an AI provider sees: a protected message has no body field to leak,
  and it is stored redacted.
- The organiser is single-writer per mailbox by design: exactly one copy of ohmail
  organises a given mailbox at a time, arbitrated through a claim in the mailbox
  itself, not through any server.

**Windows and Linux — the interface preview — connect to nothing:**

- They **make no network connection at all**, enforced three times over and each
  worth attacking separately: the webview's CSP is `connect-src 'none'`; the page
  replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and
  `navigator.sendBeacon` with functions that throw; and the Cloud sync client is
  aliased out of the bundle at build time. The Tauri capability list is empty, so
  the interface can invoke no command, read no file and spawn no process.
- Because the interface is embedded **uncompressed**, you can audit a downloaded
  binary directly: `strings -a <binary> | grep -oE 'https?://[^ ]+' | sort -u`.
- There are **no credentials** and no account — there is nothing to sign into.

**Both:** the CI-built artifacts are **unsigned** — ad-hoc signature only on macOS,
no Authenticode on Windows, nothing on Linux. That is a distribution weakness we name
openly in the README rather than a vulnerability to report: verify the artifact came
from the CI run you expect, or build from source.

## Supported versions

The project is a pre-1.0 preview. Only `main` is supported; fixes land there.
