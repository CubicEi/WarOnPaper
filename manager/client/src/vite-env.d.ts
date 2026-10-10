/// <reference types="vite/client" />

declare module "@wop/icon-preload-urls" {
  /** Deterministic `/icons/...` + `/ui/...` PNG paths from core/assets (build-time scan). */
  export const ICON_PRELOAD_URLS: readonly string[];
}
