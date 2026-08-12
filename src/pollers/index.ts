import { anthropicUsage } from "./anthropic-usage";
import { claudeCode } from "./claude-code";
import { github } from "./github";
import { openaiCosts } from "./openai-costs";
import type { Poller } from "./types";
import { uptime } from "./uptime";
import { xUsage } from "./x-usage";

// The whole "plugin system" — ADR-003: static array over dynamic registry.
// uptime runs after github so a fresh deployment has homepages to check.
export const POLLERS: Poller[] = [github, uptime, anthropicUsage, claudeCode, openaiCosts, xUsage];
