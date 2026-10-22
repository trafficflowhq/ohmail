### Building and testing from a fresh clone is checked every week on Linux, macOS and Windows

A scheduled workflow clones the repository on clean runners per platform and runs the build in the
[README](README.md) and the install and test commands in [CONTRIBUTING.md](CONTRIBUTING.md), word for word,
with no credentials; a test keeps the documents and the workflow equal. For contributors three things change:
the documented install is now `npm ci --ignore-scripts`, as in CI; the documented suite can run in parts
(`PART=2 PARTS=4` runs the second of four), one machine each; and every text file now checks out with LF line
endings on Windows too, which is what most of the suite's file-reading tests expect.
