// Secrets are set via `wrangler secret put` and invisible to `wrangler types`,
// so they are declared here by merging into the generated Env interfaces.
interface Env {
  GITHUB_PAT?: string;
  ANTHROPIC_ADMIN_KEY?: string;
  OPENAI_ADMIN_KEY?: string;
  X_BEARER_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  INGEST_TOKEN?: string;
  DIGEST_TOKEN?: string;
  NTFY_URL?: string;
  NTFY_TOKEN?: string;
  // TypeSafe is the vendor; Jev is the model it serves. Named for the vendor
  // like every other credential here, so a second TypeSafe model needs no rename.
  TYPESAFE_API_KEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_PAT?: string;
    ANTHROPIC_ADMIN_KEY?: string;
    OPENAI_ADMIN_KEY?: string;
    X_BEARER_TOKEN?: string;
    CLOUDFLARE_API_TOKEN?: string;
    INGEST_TOKEN?: string;
    DIGEST_TOKEN?: string;
    NTFY_URL?: string;
    NTFY_TOKEN?: string;
    TYPESAFE_API_KEY?: string;
  }
}
