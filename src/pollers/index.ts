import { github } from "./github";
import type { Poller } from "./types";

// The whole "plugin system" — ADR-003: static array over dynamic registry.
export const POLLERS: Poller[] = [github];
