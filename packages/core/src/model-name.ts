/**
 * IS THE MODEL A SETTINGS ROW NAMES ACTUALLY THERE — one matcher, for the two surfaces that ask.
 * The engine asks it when it verifies a provider (`ai-ollama.ts`); the desktop's provider form
 * asks it to decide which name its picker is showing. Ollama reports `family:tag` and a person
 * types the family alone, so `llama3.2` matches `llama3.2:latest` and must NOT match
 * `llama3.2-vision:latest` — family then tag, never a prefix. An id with no colon (both hosted
 * vendors') degrades to equality, which is why one matcher serves all three providers.
 */
export function installedModelName(installed: readonly string[], wanted: string): string | null {
  const [wantFamily, wantTag] = wanted.split(":", 2);
  return installed.find((name) => {
    const [family, tag] = name.split(":", 2);
    if (family !== wantFamily) return false;
    return wantTag === undefined ? true : tag === wantTag;
  }) ?? null;
}

/** On the list at all — {@link installedModelName} and nothing else, so there is one rule. */
export function hasInstalledModel(installed: readonly string[], wanted: string): boolean {
  return installedModelName(installed, wanted) !== null;
}
