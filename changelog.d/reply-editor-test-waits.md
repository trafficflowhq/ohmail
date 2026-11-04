### The reply editor's tests wait for it by time, not by a count of ticks

Five web test files that open the reply or forward editor waited for its lazily loaded module by a fixed
number of timer rounds, or not at all, and went red on a busy test machine. They now wait for the editor
to appear with a real-time bound. Nothing changes in the apps.
