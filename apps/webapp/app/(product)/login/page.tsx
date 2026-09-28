import { LoginScreen } from "./LoginScreen";
import { continuationOf } from "./continuation";
import { publicSignupEnabled } from "../../signup-mode";

/**
 * `/login`. The only thing decided here is what the screen may SAY about signing up: the note
 * under the form claims a posture, and the posture is `TF_PUBLIC_SIGNUP`, which is a server
 * decision read in one place (`signup-mode.ts`). The same read as `/join/page.tsx`, so the two
 * screens cannot answer a stranger differently — which they did. `?next=` is read here once and
 * narrowed to a name (`continuation.ts`); the screen never sees the raw value.
 */
export default async function LoginPage(
  props: { searchParams?: Promise<Record<string, string | string[] | undefined>> },
) {
  const searchParams = await props.searchParams;
  return <LoginScreen publicSignup={publicSignupEnabled()} next={continuationOf(searchParams?.next)} />;
}
