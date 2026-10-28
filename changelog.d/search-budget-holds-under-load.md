### The search speed test no longer fails on a busy machine

The test that holds a search page to 100 ms read the machine's speed only before and after each round of
measurements, so load that came and went in between could fail it on code that was no slower. It now reads a
fixed reference beside every measurement and judges a round only when that reference stayed steady
throughout and the machine's load average stayed under a quarter of its processors. A run with no such round
says SKIPPED-LOADED in its log instead of passing quietly. Every night the test also runs alone on a machine of
its own, where a run with no such round fails instead. The 100 ms budget is unchanged, and a search slower than
it still fails on a quiet machine.
