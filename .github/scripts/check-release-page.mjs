// The latest endpoint is authoritative. A prerelease flag alone does not prove this page is safe.
const [tag, prerelease, latestTag] = process.argv.slice(2);
if (tag?.startsWith("ohcal-")) {
  if (prerelease !== "true") {
    console.error("An ohcal GitHub release page must be a prerelease.");
    process.exitCode = 1;
  } else if (tag === latestTag) {
    console.error("An ohcal GitHub release page must never be Latest.");
    process.exitCode = 1;
  }
}
