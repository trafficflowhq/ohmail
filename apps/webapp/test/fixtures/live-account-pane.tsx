import { AccountPane } from "../../../../packages/app/src/account/account/AccountPane";
import { useAccount } from "../../../../packages/app/src/account/account/use-account";
import { usePassword } from "../../../../packages/app/src/account/account/use-password";
import { DoorText } from "../../app/(product)/door-device";
import { useAccountDoor } from "../../app/(product)/mailbox/account-door";
import { usePasswordDoor } from "../../app/(product)/mailbox/password-door";

const unused = () => {};

export function LiveAccountPane() {
  const account = useAccount(useAccountDoor(unused));
  const password = usePassword(usePasswordDoor());
  return (
    <DoorText>
      <AccountPane body="pane" model={account} password={password} factor={() => null} />
    </DoorText>
  );
}
