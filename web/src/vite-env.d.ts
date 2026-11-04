/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** where the person-detection model is served from (default /models/yolox_tiny.onnx) */
  readonly VITE_PRESENCE_MODEL_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
