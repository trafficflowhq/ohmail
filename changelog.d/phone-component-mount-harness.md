### The phone app's tests can mount its components

For contributors: `apps/mobile` now carries `@testing-library/react-native` and `react-test-renderer`
(19.2.3, the app's React), and `apps/mobile/test/helpers/rn-host.ts` stands in for React Native's
primitives, so a test renders a phone component, presses it and reads its styles. The "could not be
saved" notice is the first one tested that way: it renders, its Try again and Discard sit inside the
bounded scroller and stack on a narrow screen, a press reaches the engine, and a send whose outcome is
unknown keeps its warning on screen after its row is gone. Nothing changes in the app.
