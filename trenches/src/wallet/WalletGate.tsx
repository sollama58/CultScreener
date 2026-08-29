import type { ReactNode } from "react";
import { SolanaWalletProvider } from "./SolanaWalletProvider";
import { WalletBridgeProvider } from "../bridge/WalletBridgeContext";

/**
 * Everything that needs a wallet, in one chunk that is only fetched when a wallet is needed.
 *
 * This module is the boundary: importing it pulls in @solana/wallet-adapter-react and web3.js,
 * so it is loaded through React.lazy from App.tsx and nothing on the reading path imports it.
 * That keeps 131KB gzipped - 57% of this app's boot JavaScript - off the critical path for a
 * returning reader whose session cookie is already valid and who only wants to see their feed.
 *
 * Two screens sit behind it: signing in, and the paywall's burn flow. Both are moments where the
 * reader is already expecting to be asked for a signature, so a short wait to fetch the adapter
 * is invisible next to the wallet's own popup.
 */
export default function WalletGate({ children }: { children: ReactNode }) {
  return (
    <SolanaWalletProvider>
      {/* Outside any auth concern: the bridge has to keep running whether or not there's a
          session, because a signed-in user with a disconnected wallet still needs it to sign a
          burn. */}
      <WalletBridgeProvider>{children}</WalletBridgeProvider>
    </SolanaWalletProvider>
  );
}
