/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** The site backend that serves /api/image-proxy - see api/images.ts. Optional: it falls back
   *  to the same hostname switch the main site's config.js uses. */
  readonly VITE_SITE_API_URL?: string;
  readonly VITE_SOLANA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
