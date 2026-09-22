import { LoginScreen } from "./LoginScreen";
import { publicSignupEnabled } from "../../signup-mode";

/**
 * `/login`. The only thing decided here is what the screen may SAY about signing up: the note
 * under the form claims a posture, and the posture is `TF_PUBLIC_SIGNUP`, which is a server
 * decision read in one place (`signup-mode.ts`). The same read as `/join/page.tsx`, so the two
 * screens cannot answer a stranger differently — which they did.
 */
export default function LoginPage() {
  return <LoginScreen publicSignup={publicSignupEnabled()} />;
}
