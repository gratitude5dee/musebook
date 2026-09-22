// packages/ui/src/thirdweb/client.ts — §5.2 verbatim.
// Shared by apps/web and the artifact shell. No async bootstrap, no Proxy.
import { createThirdwebClient } from "thirdweb";

export const client = createThirdwebClient({
  clientId: process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID!,
});
