import type { RunContext, VendorRecipe } from "../../../src/core/types";
import type { StrategyMap } from "../../../src/core/engine";
import { createHttpFetch } from "../../../src/core/http";
import { networkStrategy } from "../../../src/core/strategies/network";
import { htmlStrategy } from "../../../src/core/strategies/html";
import { makeDomStrategy, unavailableDomStrategy } from "../../../src/core/strategies/dom";
import type { IngestSink } from "../../../src/ingest/sink";
import { createIgdrasilSink } from "../../../src/ingest/igdrasil-sink";
import { PageFetcher } from "./page-fetch";
import { FilesystemSink } from "./filesystem-sink";
import { getHostToken } from "./auth";
import { type Destination, seenStore } from "./storage";
import { BrowserDomDriver } from "./browser-dom-driver";
import { render } from "../../../src/core/template";
import { createDocumentProviderFetch } from "./document-provider-fetch";
import { createSyncMonthWindow, syncMonthWindowVars } from "../../../src/core/sync-window";

/**
 * Assembles the platform-specific pieces the platform-free core needs: the
 * credentialed fetch, the strategy set, the run context, and the ingest sink.
 * This is the wiring harness — no business logic lives here.
 *
 * DOM support is instantiated only for a recipe that needs it. Dynamic recipes
 * pass a stricter policy before reaching this runtime; packaged recipes retain
 * the same closed driver contract.
 */
export interface StrategyInstrumentation {
  /** Privacy-safe count only; no action or supplier data crosses this hook. */
  onSemanticDocumentAction?: () => void;
  /** Optional absolute cap used by no-sink discovery verification. */
  expiresAt?: number;
}

export function buildStrategies(
  recipe?: VendorRecipe,
  instrumentation: StrategyInstrumentation = {},
): StrategyMap {
  return {
    network: networkStrategy,
    dom: recipe?.invoices.strategy === "dom"
      ? makeDomStrategy(new BrowserDomDriver(
          recipe,
          undefined,
          instrumentation.onSemanticDocumentAction,
          instrumentation.expiresAt,
        ))
      : unavailableDomStrategy,
    html: htmlStrategy,
  };
}

/** A run context plus a cleanup hook (the page transport may open a tab). */
export interface PreparedRun {
  ctx: RunContext;
  dispose: () => Promise<void>;
}

export function buildRunContext(companyId: string, recipe: VendorRecipe, fromMonth?: string): PreparedRun {
  const now = new Date();
  const syncWindow = fromMonth ? createSyncMonthWindow(fromMonth, now) : undefined;
  const vars = {
    year: now.getUTCFullYear(),
    month: String(now.getUTCMonth() + 1).padStart(2, "0"),
    ...(syncWindow ? syncMonthWindowVars(syncWindow) : {}),
  };
  const seen = seenStore();

  if (recipe.fetchContext === "page") {
    const pageFetcher = new PageFetcher(recipe);
    return {
      ctx: { companyId, vars, seen, ...(syncWindow ? { syncWindow } : {}), fetch: pageFetcher.fetch },
      dispose: () => pageFetcher.dispose(),
    };
  }

  const workerFetch = createDocumentProviderFetch(createHttpFetch());
  return {
    ctx: {
      companyId,
      vars,
      seen,
      ...(syncWindow ? { syncWindow } : {}),
      fetch: async (spec, requestVars) => {
        const url = render(spec.url, requestVars);
        if (!recipeAllowsUrl(recipe, url)) throw new Error("request targets an origin outside the supplier permission set");
        return workerFetch(spec, requestVars);
      },
    },
    dispose: async () => undefined,
  };
}

export function recipeAllowsUrl(recipe: VendorRecipe, value: string): boolean {
  try {
    const origin = new URL(value).origin;
    return recipe.hosts.some((host) => {
      if (!host.endsWith("/*") || host.includes("*.")) return false;
      return new URL(host.slice(0, -2)).origin === origin;
    });
  } catch {
    return false;
  }
}

/**
 * Build the delivery path for ONE destination.
 *
 * The token provider is closed over the destination's own company, so a sink
 * can only ever attach the credential belonging to the company id it also
 * sends. There is no ambient "current token" a later configuration change
 * could redirect.
 */
export function buildSink(destination: Destination): IngestSink {
  switch (destination.kind) {
    case "filesystem":
      return new FilesystemSink({ rootFolder: destination.rootFolder, dateMode: destination.dateMode });
    case "igdrasil":
      return createIgdrasilSink({
        baseUrl: destination.endpoint,
        companyId: destination.companyId,
        getToken: () => getHostToken(destination.companyId),
      });
    case "unavailable":
      throw new DestinationNeedsReconnect(destination.reason);
  }
}

/** A destination that exists but cannot be delivered to until it is repaired. */
export class DestinationNeedsReconnect extends Error {
  constructor(readonly reason: "invalid_stored_destination" | "connection_expired") {
    super("invoice destination needs reconnection");
    this.name = "DestinationNeedsReconnect";
  }
}
