### The nightly search speed test judges a slower machine fairly

The nightly run that always judges the 100 ms search budget runs on a machine about twice as slow as the ones
the budget was measured on, so it could never find a round it counted as quiet and failed every figure over
100 ms. On a machine slower than the calibrated one, a round now counts as quiet against that machine's own
quietest reading, and each figure's computing time is scaled to the calibrated machine before it is held to 100 ms;
the simulated network round trips in a figure take as long on any machine and are not scaled. A dispatched
whole run no longer includes this job unless asked for it, so a release does not wait on it. The 100 ms budget
is unchanged, and the test on every other machine is unchanged.
