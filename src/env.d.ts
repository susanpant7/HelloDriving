/** settings read from .env files at build time (Vite) */
interface ImportMetaEnv {
  /** Mapillary client token: traffic lights and signs seen in street-level photos (Real place). Optional. */
  readonly VITE_MAPILLARY_TOKEN?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
