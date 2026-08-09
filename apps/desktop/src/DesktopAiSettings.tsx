/**
 * SETTINGS → THIS INSTALL → the model, if you want one.
 *
 * A standalone install is free and has no account, so the two things that need a model — a routing
 * suggestion for a first-contact sender, and a reply draft — run against one you supply. This pane
 * is where you say which. There is no purchase here and no allowance to top up: whatever the model
 * costs, it costs you directly, under your own key or on your own machine.
 *
 * ── THE THIRD STATE IS NOT AN ERROR ─────────────────────────────────────────────────────────
 *
 * Nothing configured is a complete, supported way to run this app. Mail is still filed, first
 * contact is still held at the Screener, search still works. What is missing is advice about
 * senders and a first draft of a reply — so the pane says that, plainly, rather than nagging.
 *
 * ── WHAT THIS COMPONENT IS NOT ALLOWED TO DECIDE ────────────────────────────────────────────
 *
 * Whether the model works, and where message content goes. Both come back from the engine on every
 * read and write, and both are RENDERED here rather than derived here — see `local-ai.ts`. A pane
 * that decided "available" for itself would show a working model to somebody whose key was revoked
 * last night, and a pane that derived "stays on this machine" from the word "Ollama" would go on
 * saying it after the address was changed to a server on the internet.
 *
 * ── AND THE KEY IS NEVER ON SCREEN ──────────────────────────────────────────────────────────
 *
 * Nothing reads a stored key back — not this pane, not the engine's own status. The field below is
 * write-only: it is empty every time the pane opens, and leaving it empty keeps whatever is stored.
 * "A key is stored" is the whole of what is ever said about it.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, SegmentedControl, SettingsNote, SettingsRow, SettingsSubhead } from "@ohmail/ui";

import {
  clearAiProvider,
  contentDestination,
  probeLine,
  readAiStatus,
  saveAiSettings,
  unavailableLine,
  verifyAiProvider,
  type AiProviderKind,
  type LocalAiStatus,
} from "./local-ai.js";

/** The three choices, including the one that is not a provider. */
type Choice = "none" | AiProviderKind;

const CHOICES: Array<{ id: Choice; label: string }> = [
  { id: "none", label: "None" },
  { id: "anthropic", label: "Your Anthropic key" },
  { id: "ollama", label: "A model on this machine" },
];

/** What is configured, in one line, for the row somebody reads before they read anything else. */
function summary(status: LocalAiStatus): string {
  if (status.provider === "anthropic") return `Anthropic · ${status.settings.anthropic.classifyModel}`;
  if (status.provider === "ollama") return `On this machine · ${status.settings.ollama.classifyModel}`;
  return "Not set up";
}

/**
 * The pane's own copy of what the fields hold, seeded from the engine and re-seeded on every write.
 *
 * `apiKey` is deliberately NOT part of it and is held apart: it is the one value that travels in
 * one direction, so it is cleared after a successful save rather than round-tripped.
 */
interface Draft {
  choice: Choice;
  anthropicClassify: string;
  anthropicDraft: string;
  ollamaBaseUrl: string;
  ollamaClassify: string;
  ollamaDraft: string;
}

function draftOf(status: LocalAiStatus): Draft {
  return {
    choice: status.provider ?? "none",
    anthropicClassify: status.settings.anthropic.classifyModel,
    anthropicDraft: status.settings.anthropic.draftModel,
    ollamaBaseUrl: status.settings.ollama.baseUrl,
    ollamaClassify: status.settings.ollama.classifyModel,
    ollamaDraft: status.settings.ollama.draftModel,
  };
}

export function DesktopAiSettings({
  /**
   * Which door this install came in by. The pane is offered on the standalone door only — an
   * install pointed at a hosted account has no local model settings, because the AI that account
   * has belongs to that account.
   */
  door,
  /** Published upward so the Screener's own control can read the same state. */
  onStatus,
}: {
  door: "local" | "cloud" | null;
  onStatus?: (status: LocalAiStatus | null) => void;
}) {
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "saving" | "testing" | "clearing">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  /** Has the first read finished? Distinct from "there is nothing configured", which is a state. */
  const [read, setRead] = useState(false);

  const land = useCallback(
    (next: LocalAiStatus | null) => {
      setStatus(next);
      setDraft(next ? draftOf(next) : null);
      // Cleared on every landing, success or not: a field that still holds a key after a save is a
      // secret sitting in the window's memory for as long as the pane is open.
      setApiKey("");
      onStatus?.(next);
    },
    [onStatus],
  );

  useEffect(() => {
    if (door !== "local") {
      setRead(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await readAiStatus();
        if (!cancelled) land(next);
      } catch (err) {
        if (!cancelled) setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setRead(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [door, land]);

  if (door !== "local") {
    return (
      <>
        <SettingsSubhead>Suggestions and drafts</SettingsSubhead>
        <SettingsRow
          label="Model"
          description={
            "This install is pointed at a hosted ohmail account, and the AI that account has is " +
            "part of it. Set up your own model on an install that opens your mail server directly."
          }
          value="latest Frontier Models"
        />
      </>
    );
  }

  const act = async (
    what: "saving" | "testing" | "clearing",
    run: () => Promise<LocalAiStatus>,
  ): Promise<void> => {
    if (busy) return;
    setBusy(what);
    setProblem(null);
    setSaid(null);
    try {
      const next = await run();
      land(next);
      // The engine verifies on every write, so the sentence below is about the configuration that
      // is now in force rather than about the one that was just typed.
      setSaid(next.available ? "Answered. Suggestions and drafts are available." : (unavailableLine(next) ?? null));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const save = (): Promise<void> =>
    act("saving", async () => {
      const d = draft!;
      return saveAiSettings({
        provider: d.choice === "none" ? null : d.choice,
        anthropic: {
          classifyModel: d.anthropicClassify,
          draftModel: d.anthropicDraft,
          // OMITTED WHEN EMPTY, and that is the whole reason changing a model does not cost you a
          // trip to your provider's dashboard: an absent key keeps the stored one.
          ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
        },
        ollama: {
          baseUrl: d.ollamaBaseUrl,
          classifyModel: d.ollamaClassify,
          draftModel: d.ollamaDraft,
        },
      });
    });

  if (!read || !draft || !status) {
    return (
      <>
        <SettingsSubhead>Suggestions and drafts</SettingsSubhead>
        {problem ? <p className="join-error">{problem}</p> : null}
        <SettingsRow
          label="Model"
          description="Asking the mail engine what this install has."
          value={problem ? "—" : "…"}
        />
      </>
    );
  }

  const unavailable = unavailableLine(status);
  const models = status.probe?.models ?? [];
  const working = busy !== null;

  return (
    <>
      <SettingsSubhead>Suggestions and drafts</SettingsSubhead>

      <SettingsRow label="Model" description={contentDestination(status)} value={summary(status)} />

      <SettingsRow
        label="State"
        description={
          status.available
            ? (probeLine(status.probe) ?? "Answered when it was last asked.")
            : (unavailable ??
              "Mail is filed by rules alone. Suggestions and drafts are not offered.")
        }
        value={status.available ? "Working" : "Not in use"}
      />

      {problem ? <p className="join-error">{problem}</p> : null}
      {said ? <p className="join-hint">{said}</p> : null}

      <SettingsRow
        label="Where the model comes from"
        description={
          "Choosing a different one clears the last test. Nothing is offered until the endpoint " +
          "answers again."
        }
        control={
          <SegmentedControl
            options={CHOICES}
            value={draft.choice}
            onChange={(choice) => setDraft({ ...draft, choice })}
            ariaLabel="Where the model comes from"
          />
        }
      />

      {draft.choice === "anthropic" ? (
        <>
          {status.canStoreKey ? (
            <>
              <label className="join-label" htmlFor="ai-key">
                API key {status.settings.anthropic.hasKey ? "— one is stored; leave empty to keep it" : ""}
              </label>
              <input
                id="ai-key"
                className="join-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={status.settings.anthropic.hasKey ? "•••••••• stored" : "Paste your key"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="join-hint">
                The key goes straight to the mail engine, which seals it under a key held in this
                computer&rsquo;s keychain. It is never shown again, never written down in the clear,
                and is sent nowhere but Anthropic.
              </p>
            </>
          ) : (
            <p className="join-hint">
              This install has no durable key of its own, so a secret cannot be stored on this
              machine. A model running here needs no key and still works.
            </p>
          )}

          <label className="join-label" htmlFor="ai-a-classify">Model for suggestions</label>
          <input
            id="ai-a-classify"
            className="join-input"
            list="ai-models"
            value={draft.anthropicClassify}
            onChange={(e) => setDraft({ ...draft, anthropicClassify: e.target.value })}
          />

          <label className="join-label" htmlFor="ai-a-draft">Model for reply drafts</label>
          <input
            id="ai-a-draft"
            className="join-input"
            list="ai-models"
            value={draft.anthropicDraft}
            onChange={(e) => setDraft({ ...draft, anthropicDraft: e.target.value })}
          />
        </>
      ) : null}

      {draft.choice === "ollama" ? (
        <>
          <label className="join-label" htmlFor="ai-o-base">Address of the model server</label>
          <input
            id="ai-o-base"
            className="join-input join-code"
            value={draft.ollamaBaseUrl}
            onChange={(e) => setDraft({ ...draft, ollamaBaseUrl: e.target.value })}
          />

          <label className="join-label" htmlFor="ai-o-classify">Model for suggestions</label>
          <input
            id="ai-o-classify"
            className="join-input"
            list="ai-models"
            value={draft.ollamaClassify}
            onChange={(e) => setDraft({ ...draft, ollamaClassify: e.target.value })}
          />

          <label className="join-label" htmlFor="ai-o-draft">Model for reply drafts</label>
          <input
            id="ai-o-draft"
            className="join-input"
            list="ai-models"
            value={draft.ollamaDraft}
            onChange={(e) => setDraft({ ...draft, ollamaDraft: e.target.value })}
          />
        </>
      ) : null}

      {/* WHAT THE ENDPOINT SAID IT HAS, from the last test — so a name is chosen from a real list
          rather than typed from memory. Empty until a test has run, which is honest: nothing has
          asked it yet. It belongs to whichever provider was verified last, which is the one whose
          fields are on screen in every case but the moment after a switch. */}
      {models.length > 0 ? (
        <datalist id="ai-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ) : null}

      <SettingsRow
        label={draft.choice === "none" ? "Save" : "Save and test"}
        description={
          draft.choice === "none"
            ? "Forgets the provider and any stored key. Mail keeps arriving and keeps being filed."
            : "Saves these settings and asks the endpoint whether it is there. The test lists models and asks for one by name — it runs nothing and costs nothing."
        }
        control={
          <span className="set-tag-acts">
            <Button variant="primary" onClick={() => void save()} disabled={working}>
              {busy === "saving" ? "Saving…" : "Save"}
            </Button>
            {status.provider ? (
              <Button onClick={() => void act("testing", verifyAiProvider)} disabled={working}>
                {busy === "testing" ? "Testing…" : "Test connection"}
              </Button>
            ) : null}
          </span>
        }
      />

      {status.provider || status.settings.anthropic.hasKey ? (
        <SettingsRow
          label="Remove"
          description="Forgets the provider and the stored key. Nothing about your mail changes."
          control={
            <Button variant="ghost" className="danger" onClick={() => void act("clearing", clearAiProvider)} disabled={working}>
              {busy === "clearing" ? "Removing…" : "Remove"}
            </Button>
          }
        />
      ) : null}

      {/* WRITTEN FOR THIS PANE AND NOT BORROWED FROM THE ONE ABOVE IT, because the two are not the
          same claim. The mailbox password never passes through this window at all. An API key does
          — you type it here — and what is true of it is the sentence below: it goes down the pipe
          to the mail engine, is sealed there, and is never read back to this window afterwards. */}
      <SettingsNote>
        An API key you type here goes straight down to the mail engine, which seals it under a key
        held in this computer&rsquo;s keychain and never hands it back. Only what a model needs to
        answer is sent to it: the sender, the subject and a short extract. Mail this app judges
        sensitive is never sent at all, whichever provider is chosen.
      </SettingsNote>
    </>
  );
}
