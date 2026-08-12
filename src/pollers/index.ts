import { anthropicUsage } from "./anthropic-usage";
import { github } from "./github";
import type { Poller } from "./types";
import { uptime } from "./uptime";

// The whole "plugin system" — ADR-003: static array over dynamic registry.
// uptime runs after github so a fresh deployment has homepages to check.
export const POLLERS: Poller[] = [github, uptime, anthropicUsage];
