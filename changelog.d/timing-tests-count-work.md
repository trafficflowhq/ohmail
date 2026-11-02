### Three timing tests wait for events, not milliseconds

For contributors: three tests that went red on busy test machines with nothing wrong in the code now wait
for what they check instead of a fixed delay. The sign-in refresh race tests measure the reuse window on a
clock the test moves; the live-updates test sends its change once both listeners are subscribed and ends
each stream after it has carried the change; the worker's billing-plane watch test waits for its state line
before reading it. What each test asserts is unchanged.
