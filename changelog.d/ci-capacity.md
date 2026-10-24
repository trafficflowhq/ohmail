### A draft pull request waits for review before the full CI run

A draft pull request now runs only the sign-off check, the guard check and the `changes` jobs that decide
which builds it needs. Marking it ready for review starts the test suite, the engine jobs and the platform
builds it needs. A newer push to a pull request still cancels its older run, and a nightly or manual run is
never cancelled or dropped while it waits.
