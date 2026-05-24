/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MERCHANT_CPI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
