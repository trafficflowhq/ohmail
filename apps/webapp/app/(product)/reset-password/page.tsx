import type { SearchParamsLike } from "../../demo-mode";
import { PasswordResetText } from "./PasswordResetText";
import { ResetPasswordRoute } from "./ResetPasswordRoute";

export default async function ResetPasswordPage({ searchParams }: { searchParams?: Promise<SearchParamsLike> }) {
  const raw = (await searchParams)?.token;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (
    <PasswordResetText>
      <ResetPasswordRoute initialToken={typeof first === "string" ? first.trim().slice(0, 512) : ""} />
    </PasswordResetText>
  );
}
