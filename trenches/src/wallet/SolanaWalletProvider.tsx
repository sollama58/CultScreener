import type { ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";

const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || "https://solana-rpc.publicnode.com";

/**
 * Sign-in never submits a transaction (SIWS just signs a message), so this
 * connection is only used by the wallet adapter's internal plumbing - any
 * reachable RPC endpoint works, no paid/high-throughput provider needed.
 *
 * No explicit wallet adapters (no @solana/wallet-adapter-wallets, deliberately)
 * - Phantom, Solflare, Backpack, and every other current wallet implement the
 * Wallet Standard, which @solana/wallet-adapter-react auto-detects via the
 * browser's wallet registry. Explicit adapters are now only needed for
 * legacy wallets that predate the standard, which isn't a case we need to
 * cover. This keeps the dependency tree (and its vulnerability surface)
 * drastically smaller.
 *
 * WalletModalProvider (and its stylesheet) is deliberately absent: inside HolDEX the wallet is
 * chosen by the site header's Connect Wallet button, and this app picks that same wallet up
 * through src/bridge/holdexWallet.ts. There is no second wallet picker to render, and dropping
 * it also keeps @solana/wallet-adapter-react-ui's global CSS out of a page that now shares a
 * document with the site's own stylesheet.
 *
 * autoConnect is what makes the bridge silent: once useHoldexWalletBridge() calls select() with
 * the wallet the user already approved on the main site, the adapter reconnects to an
 * already-authorised origin without a popup.
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
