export function checkReferences(given: {
  folders: string[];
  references: string[];
  explicit: string[];
}): string[];
export function explicitTypechecks(given: {
  workflows: string[];
  rootScripts: Record<string, string>;
  manifests: Record<string, { scripts?: Record<string, string> }>;
}): string[];
