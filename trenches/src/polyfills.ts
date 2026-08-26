/**
 * @solana/web3.js and bs58 assume a Node-like global environment (Buffer,
 * `global`). Vite doesn't polyfill Node builtins by default, so without
 * this the page loads fine but wallet operations (connect, signMessage,
 * PublicKey encoding) throw at runtime the first time one of those
 * libraries touches Buffer - confirmed via a browser smoke test showing
 * "Module 'buffer' has been externalized for browser compatibility".
 *
 * Must be imported first, before anything that might construct a
 * PublicKey or touch bs58 - see main.tsx.
 */
import { Buffer } from "buffer";

declare global {
  interface Window {
    Buffer: typeof Buffer;
  }
}

if (!window.Buffer) {
  window.Buffer = Buffer;
}
