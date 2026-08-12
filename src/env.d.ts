// Secrets are set via `wrangler secret put` and invisible to `wrangler types`,
// so they are declared here by merging into the generated Env interfaces.
interface Env {
  GITHUB_PAT?: string;
  ANTHROPIC_ADMIN_KEY?: string;
  OPENAI_ADMIN_KEY?: string;
  X_BEARER_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  INGEST_TOKEN?: string;
  NTFY_URL?: string;
  NTFY_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_PAT?: string;
    ANTHROPIC_ADMIN_KEY?: string;
    OPENAI_ADMIN_KEY?: string;
    X_BEARER_TOKEN?: string;
    CLOUDFLARE_API_TOKEN?: string;
    INGEST_TOKEN?: string;
    NTFY_URL?: string;
    NTFY_TOKEN?: string;
  }
}
