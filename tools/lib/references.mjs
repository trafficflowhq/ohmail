// The typed contracts hold only for a project the type check reaches. Every folder under apps/ and
// packages/ that has a tsconfig is in the root build's references, or a workflow checks it by name.

const folderOf = (reference) => reference.replace(/^\.\//, "").split("/").slice(0, 2).join("/");

/**
 * @param {object} given
 * @param {string[]} given.folders the folders that have a tsconfig.json
 * @param {string[]} given.references the root tsconfig.json's reference paths
 * @param {string[]} given.explicit the folders a workflow type-checks by name
 */
export function checkReferences({ folders, references, explicit }) {
  const reached = new Set([...references.map(folderOf), ...explicit]);
  return folders
    .filter((folder) => !reached.has(folder))
    .map(
      (folder) =>
        `references: ${folder} has a tsconfig that no type check reaches; add it to the root tsconfig.json's references`,
    );
}

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `npm run <name>` by the script's whole name: `typecheck` is not run by `npm run typecheck:mobile`. */
const runs = (name) => `npm run ${literal(name)}(?![\\w:.-])`;

/** A workflow's steps, each with the folder its `working-directory` names (none: the root). */
function stepsOf(workflow) {
  return workflow.split(/^(?=[ \t]*- )/m).map((text) => {
    const folder = /^[ \t-]*working-directory:[ \t]*["']?([^\s"'#]+)/m.exec(text)?.[1];
    return { text, folder: folder?.replace(/^\.\//, "").replace(/\/$/, "") ?? null };
  });
}

/** The folders a workflow or a root script type-checks with `tsc -p <folder>/tsconfig…`. */
export function explicitTypechecks({ workflows, rootScripts, manifests }) {
  const text = workflows.join("\n");
  const steps = workflows.flatMap(stepsOf);
  const atRoot = steps.filter((step) => step.folder === null);
  const named = Object.entries(rootScripts)
    .filter(([name]) => atRoot.some((step) => new RegExp(runs(name)).test(step.text)))
    .map(([, command]) => command);
  const found = new Set();
  for (const source of [text, ...named]) {
    for (const match of source.matchAll(/-p ((?:apps|packages)\/[a-z0-9-]+)\/tsconfig/g)) found.add(match[1]);
  }
  // A folder with its own install is checked by its own script, where a workflow runs it in that folder:
  // the step's working-directory, or `cd <folder> && npm run <name>` on one line.
  for (const [folder, manifest] of Object.entries(manifests)) {
    const scripts = Object.entries(manifest.scripts ?? {}).filter(([, command]) => /\btsc\b/.test(command));
    const runsHere = ([name]) => {
      const inFolder = new RegExp(runs(name));
      const afterCd = new RegExp(`(^|[\\s;&|(])cd ${literal(folder)}/?[ \\t]*(&&|;)[^\\n]*${runs(name)}`);
      return steps.some((step) => (step.folder === folder ? inFolder : afterCd).test(step.text));
    };
    if (scripts.some(runsHere)) found.add(folder);
  }
  return [...found];
}
