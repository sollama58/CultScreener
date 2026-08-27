import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { claimBurn, getBlockhash, sendBurnTransaction, ApiError } from "../api/client";
import { useSubscription } from "../context/SubscriptionContext";
import {
  associatedTokenAddress,
  clearPendingBurn,
  createBurnInstruction,
  readPendingBurn,
  rememberPendingBurn,
  serializeSigned,
  toRawAmount,
} from "../utils/burn";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; step: string }
  | { kind: "claiming"; signature: string; attempt: number }
  | { kind: "done" }
  | { kind: "error"; message: string; burned: boolean };

/** How long to keep re-asking the API to credit a burn before handing off to the reconciler. */
const CLAIM_ATTEMPTS = 20;
const CLAIM_DELAY_MS = 3_000;

export function Paywall() {
  const { status, refresh } = useSubscription();
  const { publicKey, signTransaction } = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Survives re-renders so a claim loop started before a refresh doesn't get orphaned.
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  /**
   * Ask the API to credit a burn, retrying while it reports the transaction hasn't finalised.
   *
   * Gives up eventually, and says so honestly: the reconciler will credit it within a few minutes
   * whatever happens here, so the worst case is a wait, never a loss. That is worth saying on
   * screen, because a spinner that stops without explanation after someone has spent tokens is
   * exactly when people panic.
   */
  const claimWithRetry = useCallback(
    async (signature: string) => {
      for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
        if (cancelled.current) return;
        setPhase({ kind: "claiming", signature, attempt });
        try {
          const result = await claimBurn(signature);
          if (result.status === "credited" || result.status === "already_credited") {
            clearPendingBurn();
            await refresh();
            setPhase({ kind: "done" });
            return;
          }
          if (result.status === "held") {
            clearPendingBurn();
            setPhase({
              kind: "error",
              burned: true,
              message: result.message ?? "That burn was made by a different wallet.",
            });
            return;
          }
          // "pending" - not finalised yet. Wait and ask again.
        } catch (err) {
          if (err instanceof ApiError && err.status === 400) {
            clearPendingBurn();
            setPhase({ kind: "error", burned: true, message: err.message });
            return;
          }
          // Anything else is a transport problem; keep trying.
        }
        await new Promise((resolve) => setTimeout(resolve, CLAIM_DELAY_MS));
      }

      setPhase({
        kind: "error",
        burned: true,
        message:
          "Your burn went through, but confirming it is taking longer than usual. Access is applied automatically within a few minutes - you can close this page and come back.",
      });
    },
    [refresh],
  );

  // A burn broadcast in a previous page load that never got confirmed here. Picked up on mount so
  // a reload mid-flow resumes rather than stranding the user.
  useEffect(() => {
    const pending = readPendingBurn();
    if (pending && publicKey && pending.wallet === publicKey.toBase58()) {
      void claimWithRetry(pending.signature);
    }
  }, [publicKey, claimWithRetry]);

  const burn = async () => {
    if (!publicKey || !signTransaction || !status) return;
    const { price } = status;

    try {
      // Pre-flight FIRST. If the API is unreachable, say so now, while the user still has their
      // tokens - rather than after the network has destroyed them.
      setPhase({ kind: "working", step: "Checking the connection…" });
      const { blockhash } = await getBlockhash();

      setPhase({ kind: "working", step: "Approve the burn in your wallet…" });
      const mint = new PublicKey(price.mint);
      const tokenAccount = associatedTokenAddress(publicKey, mint);
      const instruction = createBurnInstruction(
        tokenAccount,
        mint,
        publicKey,
        toRawAmount(price.tokensPerMonth, price.decimals),
      );

      const transaction = new Transaction().add(instruction);
      transaction.feePayer = publicKey;
      transaction.recentBlockhash = blockhash;

      const signed = await signTransaction(transaction);

      setPhase({ kind: "working", step: "Sending…" });
      const { signature } = await sendBurnTransaction(serializeSigned(signed));

      // Written down before anything else can go wrong. The API already recorded it too - this is
      // the copy that survives a reload of this tab.
      rememberPendingBurn(signature, publicKey.toBase58());
      await claimWithRetry(signature);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A wallet rejection is the one error where nothing was spent, so it must not be dressed up
      // as a failure that might have cost something.
      const rejected = /reject|denied|cancel|user rejected/i.test(message);
      setPhase({
        kind: "error",
        burned: false,
        message: rejected ? "You cancelled the burn - nothing was spent." : message,
      });
    }
  };

  if (!status) return <p className="empty-state">Checking your access…</p>;

  const expired = status.expiresAt !== null && new Date(status.expiresAt) < new Date();
  const busy = phase.kind === "working" || phase.kind === "claiming";
  // Both are needed to build and sign: a wallet can be connected but not expose signTransaction.
  const walletReady = publicKey !== null && typeof signTransaction === "function";

  return (
    <div className="paywall">
      <div className="paywall__card">
        <h2 className="paywall__title">{expired ? "Your access has expired" : "Trenches is subscriber-only"}</h2>

        {expired && status.expiresAt && (
          <p className="paywall__lapsed">Expired {new Date(status.expiresAt).toLocaleDateString()}</p>
        )}

        <p className="paywall__lede">
          Burn <strong>{status.price.tokensPerMonth.toLocaleString()} $ASDFASDFA</strong> for{" "}
          <strong>{status.price.daysPerMonth} days</strong> of access to the live feed, your filters and the
          leaderboard.
        </p>

        <ul className="paywall__points">
          <li>The tokens are destroyed, not collected - the burn reduces supply.</li>
          <li>Burn a multiple to buy several months at once.</li>
          <li>Renewing early adds to your remaining time rather than replacing it.</li>
          <li>
            Access is granted from the chain, so if the burn lands you get the time - even if this page
            closes halfway through.
          </li>
        </ul>

        {phase.kind === "done" && <p className="paywall__ok">Access granted. Welcome in.</p>}

        {busy && (
          <p className="paywall__status" role="status">
            {phase.kind === "working" ? phase.step : `Confirming your burn… (${phase.attempt}/${CLAIM_ATTEMPTS})`}
          </p>
        )}

        {phase.kind === "error" && (
          <p className={`paywall__error${phase.burned ? " paywall__error--burned" : ""}`} role="alert">
            {phase.message}
          </p>
        )}

        {/*
          The session outlives the wallet connection - it's a cookie, and the wallet adapter starts
          every page load disconnected. So someone can arrive here properly signed in with no
          wallet attached to this tab, and the button has to say why it can't do anything rather
          than sit there greyed out looking broken.
        */}
        <button
          className="btn btn--primary paywall__cta"
          onClick={() => void burn()}
          disabled={busy || !walletReady}
        >
          {busy
            ? "Working…"
            : walletReady
              ? `Burn ${status.price.tokensPerMonth.toLocaleString()} $ASDFASDFA`
              : "Connect your wallet to burn"}
        </button>

        {!walletReady && !busy && (
          <p className="paywall__status paywall__status--center">
            Use the <strong>Connect Wallet</strong> button in the header, then come back here.
          </p>
        )}

        <p className="paywall__footnote">
          Don't have any?{" "}
          <a href={`https://pump.fun/coin/${status.price.mint}`} target="_blank" rel="noreferrer">
            Get $ASDFASDFA on pump.fun
          </a>
        </p>
      </div>
    </div>
  );
}
