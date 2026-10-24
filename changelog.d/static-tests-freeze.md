### Contributors: tests that read source as text are frozen

A new test drives the code and asserts what comes out. `test/source-text-freeze.test.ts` refuses a test file that reads product source as text unless `test/support/source-text-baseline.txt`, today's list of such files, or `test/support/source-text-guards.tsv`, the guards no behaviour test can reach, names it. A listed file may not read more source than it does today, and the list only shrinks: 21 web app tests that ran no product code and pinned how styles and code are spelled are removed.
