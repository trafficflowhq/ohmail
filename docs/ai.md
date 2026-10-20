# Rules, suggestions and models

The short version is in the [README](../README.md#rules-first-ai-optional).

## Rules first

Rules do the filing, and they need no model. Configure nothing and the Screener
still holds first contact, rules still file mail, and search still works; the
suggestion and the reply draft are not offered.

Spam needs no AI either: one press files the message into your mailbox's own
Junk folder, where the mailbox has one, and the sender rule remembers, so the
next mail from that sender never reaches the Screener. Plain newsletters and
receipts can be filed out of the Screener by deterministic rules alone, once you
switch that on. ohmail deletes nothing on its own.

Screening a sender out or marking spam also sends the list's one-click
unsubscribe on your behalf, where one is offered and your mail provider
confirmed the sender. It is on by default; a switch turns it off.

## What the Screener proposes

With AI on (your own Anthropic, OpenAI or OpenCode Go key, or a local model
through [Ollama](https://ollama.com), and off until you turn it on) the Screener
proposes a door for each waiting sender, with a confidence and a reason, and one
press accepts. Switch on auto-suggest and the proposal is already waiting as the
mail arrives.

Nothing applies itself unless you ask. A pattern you have confirmed often
enough graduates and files itself from then on, spam included. Or switch on
"Act on confident suggestions for me" and a sender whose suggestion is confident
is filed for you, never someone you have written to, with the rule listed for
you to undo. A screen-out or spam verdict about a message your provider did not
confirm files only that message, writes no rule, and lists it under Filed
automatically to put back. Every move is recorded and reversible.

A reply draft lands in the editor; no email is sent.

## Codes never reach a model

A one-time code inside a message is stripped before any model sees it, and
automatic routing leaves that mail alone entirely.

## Model providers and keys

Pick the model in **Settings → Desktop**, under *AI for suggestions and drafts*.
Four options:

- **Your Anthropic key**: requests go to `api.anthropic.com`, billed to your
  account.
- **Your OpenAI key**: requests go to `api.openai.com`, billed to your account.
- **Your OpenCode Go key**: requests go to `opencode.ai` and on to the provider
  behind the model you choose, billed through your OpenCode account. The models
  to choose from are the ones your Go workspace lists that this app can drive;
  Settings shows them after the key is checked, and marks the free and preview
  ones. The check reads your workspace's Go configuration and runs no model, so
  it does not prove the model will answer. Eligibility, model privacy and billing
  are managed in your OpenCode account, where ohmail cannot see or enforce them.
- **A model on this machine**: served by Ollama at `http://127.0.0.1:11434` by
  default, or any address you give it. Install Ollama and `ollama pull llama3.2`
  before choosing it. Nothing leaves the machine if the server is on it.
  `llama3.2` is the default because it is the smallest model measured to do both
  jobs; something much smaller will suggest a door and then fail to write a
  draft, and says so rather than hanging.

A key is sealed under a key held in your operating system's keystore, is never
written down in the clear, is never read back, and is sent to no host but its
own vendor's. The endpoint for a key is fixed in the code and no setting can
move it; the option whose address you can change is the local one, which
carries no key. Saving runs a fresh test (for OpenCode Go, the configuration
read above), so a server that is not running, or is running without the model
you named, is reported while you are still in the settings rather than the next
time you open your mail.

## On a server you run

The self-host stack offers the same four providers and reads the choice from
`.env` (`TF_AI_PROVIDER` and one variable per provider).
[self-host/README.md](self-host/README.md#screener-suggestions-and-reply-drafts)
has the table and every setting.
