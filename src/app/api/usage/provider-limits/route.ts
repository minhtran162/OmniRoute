import { NextRequest, NextResponse } from "next/server";
import {
  fetchAndPersistProviderLimits,
  getCachedProviderLimitsMap,
  getLastProviderLimitsAutoSyncTime,
  getProviderLimitsSyncIntervalMinutes,
  syncAllProviderLimits,
} from "@/lib/usage/providerLimits";

/**
 * GET /api/usage/provider-limits
 * Returns cached Provider Limits data without triggering live refreshes.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const connectionId = searchParams.get("connectionId");

    if (connectionId) {
      const { usage, cache } = await fetchAndPersistProviderLimits(connectionId, "manual");
      return NextResponse.json({
        usage,
        cache,
        caches: getCachedProviderLimitsMap(),
        intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
        lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
      });
    }

    return NextResponse.json({
      caches: getCachedProviderLimitsMap(),
      intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
      lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    });
  } catch (error) {
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : 500;
    console.error("[API] GET /api/usage/provider-limits error:", error);
    return NextResponse.json(
      { error: (error as Error)?.message || "Failed to fetch provider limits" },
      { status }
    );
  }
}

/**
 * POST /api/usage/provider-limits
 * Manually refresh all supported Provider Limits entries.
 */
export async function POST() {
  try {
    const result = await syncAllProviderLimits({ source: "manual" });
    const caches = getCachedProviderLimitsMap();
    return NextResponse.json({
      ...result,
      caches,
      intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
      lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    });
  } catch (error) {
    console.error("[API] POST /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to refresh provider limits" }, { status: 500 });
  }
}
