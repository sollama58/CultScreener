import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import prefixSelector from "postcss-prefix-selector";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Scope every rule this app emits under `.trenches-app` (the class on #root in index.html).
 *
 * Unlike in the original standalone deployment, this page also loads the main site's
 * stylesheet (frontend/css/styles.css) so the shared header renders correctly. That puts two
 * independently-written stylesheets in one document, and this app's CSS opens with bare
 * `*`, `html, body, #root` and `button, input, select` rules that would otherwise restyle the
 * site header sitting above the app.
 *
 * Done as a build step rather than by hand-editing 900+ lines of selectors so the stylesheet
 * stays a straightforward, diffable copy of upstream's.
 */
const scopeToApp = prefixSelector({
  prefix: ".trenches-app",
  transform(prefix, selector, prefixedSelector) {
    // Document-level selectors have no meaning inside a scope — retarget them at the app root
    // itself so custom properties and the height/font chain still land somewhere useful.
    if (selector === ":root" || selector === "html" || selector === "body" || selector === "#root") {
      return prefix;
    }
    // `*` would become `.trenches-app *`, which misses the root element itself.
    if (selector === "*") return `${prefix}, ${prefix} *`;
    // Keyframe steps (`from`, `to`, `0%`) are not selectors and must pass through untouched.
    if (/^(from|to|\d+%)$/.test(selector)) return selector;
    return prefixedSelector;
  },
});

export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [scopeToApp],
    },
  },
  // Served from https://holdex.live/trenches/, not the domain root, so every emitted asset URL
  // needs this prefix. Without it the bundle requests /assets/*.js and gets the static host's
  // 404 (or, via the SPA rewrite, index.html as "JavaScript") and the app never boots.
  base: "/trenches/",
  // This app used to live in the TrenchScanner monorepo, which shared one root .env across
  // apps; here it stands alone, so env files come from this directory. (Vite only ever exposes
  // VITE_-prefixed keys to client code either way.) Left explicit rather than defaulted so the
  // old ../.. path can't quietly resolve to somewhere outside this repo.
  envDir: here,
  // @solana/web3.js and friends assume a Node-like global; Buffer itself is polyfilled
  // explicitly in src/polyfills.ts (imported first in main.tsx), this just covers the bare
  // `global` reference some of the same libraries make.
  define: {
    global: "globalThis",
  },
  build: {
    // Emit straight into the published tree (frontend/ is Render's Publish Directory), so the
    // built SPA ships as part of the same static site as the existing pages. Kept outside
    // this package directory so `npm install` here can never put node_modules under the
    // published root.
    outDir: resolve(here, "../frontend/trenches"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Without this, Rollup's default is one ~600kB app+vendor bundle - every deploy
        // invalidates the whole thing, so a returning user re-downloads React, @solana/web3.js
        // and the wallet adapters (which almost never change) just because a component's JSX
        // changed. Splitting vendor code into its own hashed chunks means those chunks keep the
        // same filename (and stay cached) across deploys where only our own app code changed.
        manualChunks: (id) => vendorChunkFor(id),
      },
    },
  },
});

/**
 * Buckets a node_modules module into a coarse vendor chunk by top-level package name, for the
 * handful of large, semantically-distinct dependencies that dominate bundle size and tend to
 * change independently of both our own code and each other:
 *  - vendor-react: essentially never changes without a deliberate React version bump.
 *  - vendor-wallet: the wallet-adapter/wallet-standard surface we integrate against directly in
 *    AuthContext - worth isolating from web3.js itself since it churns a bit more.
 *  - vendor-solana: @solana/web3.js plus the two small crypto/polyfill libs we import directly
 *    alongside it (bs58, buffer) - the "talk to the chain" layer.
 * Everything else (smaller transitive deps not named above) is left for Rollup's own default
 * chunking - forcing every last transitive dependency into a named bucket produced circular
 * chunk dependencies here (a small shared polyfill imported by both a bucketed and an
 * un-bucketed module), which is worse for caching than just letting Rollup decide. Application
 * code (anything outside node_modules) is likewise left alone, so it stays in the entry chunk
 * that's expected to change on nearly every deploy.
 */
function vendorChunkFor(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;

  const afterNodeModules = id.split("node_modules/").at(-1) ?? "";
  const segments = afterNodeModules.split("/");
  const pkgName = segments[0]?.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];

  if (pkgName === "react" || pkgName === "react-dom" || pkgName === "scheduler") return "vendor-react";
  if (pkgName?.startsWith("@solana/wallet-adapter") || pkgName?.startsWith("@solana/wallet-standard")) {
    return "vendor-wallet";
  }
  // buffer gets its OWN chunk, and must not simply be left unbucketed. The Buffer polyfill runs
  // at boot, before anything can touch a PublicKey (see polyfills.ts), while web3.js also depends
  // on buffer - so with no rule for it Rollup parks the shared dependency inside vendor-solana and
  // the entry then has to import that whole chunk. 81KB gzipped of chain code stayed pinned to the
  // boot path no matter how carefully the wallet screens were made lazy, which the build manifest
  // showed and reading the code did not. Naming it breaks that tie: both sides import a small
  // shared chunk instead.
  if (pkgName === "buffer" || pkgName === "base64-js" || pkgName === "ieee754") return "vendor-buffer";
  if (pkgName === "@solana/web3.js" || pkgName === "bs58") return "vendor-solana";
  return undefined;
}
