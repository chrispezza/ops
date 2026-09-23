import { anthropicUsage } from "./anthropic-usage";
import { claudeCode } from "./claude-code";
import { cloudflare } from "./cloudflare";
import { github } from "./github";
import { judge } from "./judge";
import { manifests } from "./manifests";
import { openaiCosts } from "./openai-costs";
import type { Poller } from "./types";
import { uptime } from "./uptime";
import { xUsage } from "./x-usage";

// The whole "plugin system" — ADR-003: static array over dynamic registry.
// Order is load-bearing. uptime runs after github so a fresh deployment has
// homepages to check. judge runs LAST: it is advisory (ADR-006) and the one
// poller whose cost scales with the backlog, and while it ran first it spent
// the invocation's subrequest budget and took spend, manifests and the D1
// budget watchers dark for five days (#68). Its repo list comes from what
// github recorded, which any position after github satisfies.
export const POLLERS: Poller[] = [github, uptime, anthropicUsage, claudeCode, openaiCosts, xUsage, manifests, cloudflare, judge];
