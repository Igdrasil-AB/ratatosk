import type { RunContext, VendorRecipe } from "../core/types";
import type { StrategyMap } from "../core/engine";
import { createHttpFetch } from "../core/http";
import { networkStrategy } from "../core/strategies/network";
import { htmlStrategy } from "../core/strategies/html";
import { unavailableDomStrategy } from "../core/strategies/dom";
import type { IngestSink } from "../ingest/sink";
import { HttpSink } from "../ingest/http-sink";
import { createIgdrasilSink } from "../ingest/igdrasil-sink";
import { PageFetcher } from "./page-fetch";
import { FilesystemSink } from "./filesystem-sink";
import { getHostToken } from "./auth";
import { getSinkConfig, seenStore } from "./storage";

/**
 * Assembles the platform-specific pieces the platform-free core needs: the
 * credentialed fetch, the strategy set, the run context, and the ingest sink.
 * This is the wiring harness — no business logic lives here.
 *
 * The DOM strategy is left unavailable until an offscreen driver is wired
 * (see `src/core/strategies/dom.ts`); network replay covers the current vendors.
 */
export function buildStrategies(): StrategyMap {
  return { network: networkStrategy, dom: unavailableDomStrategy, html: htmlStrategy };
}

/** A run context plus a cleanup hook (the page transport may open a tab). */
export interface PreparedRun {
  ctx: RunContext;
  dispose: () => Promise<void>;
}

export function buildRunContext(companyId: string, recipe: VendorRecipe): PreparedRun {
  const now = new Date();
  const vars = {
    year: now.getUTCFullYear(),
    month: String(now.getUTCMonth() + 1).padStart(2, "0"),
  };
  const seen = seenStore();

  if (recipe.fetchContext === "page") {
    const pageFetcher = new PageFetcher(recipe);
    return {
      ctx: { companyId, vars, seen, fetch: pageFetcher.fetch },
      dispose: () => pageFetcher.dispose(),
    };
  }

  return {
    ctx: { companyId, vars, seen, fetch: createHttpFetch() },
    dispose: async () => undefined,
  };
}

export async function buildSink(): Promise<IngestSink> {
  const cfg = await getSinkConfig();
  if (!cfg) throw new Error("collector is not configured — set a destination in the popup first");
  switch (cfg.kind) {
    case "filesystem":
      return new FilesystemSink({ rootFolder: cfg.rootFolder, dateMode: cfg.dateMode });
    case "igdrasil":
      return createIgdrasilSink({ baseUrl: cfg.endpoint, companyId: cfg.companyId, getToken: getHostToken });
    case "http":
      return new HttpSink({ endpoint: cfg.endpoint, companyId: cfg.companyId, token: getHostToken });
  }
}
