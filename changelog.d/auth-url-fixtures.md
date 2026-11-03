### The test suite's sign-in links and sample passwords are made at run time

The tests that decide whether a sign-in link in a message carries a credential now build every token
in their links at run time, at reserved example domains, instead of keeping whole links at real
services. The sample passwords across the test suite are fixture values that name themselves. Nothing
changes in the apps.
