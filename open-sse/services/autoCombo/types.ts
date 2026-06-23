/**
 * Auto-Combo Scoring Types & Constants
 */

export interface ScoringFactors {
  quota: number;
  health: number;
  costInv: number;
  latencyInv: number;
  taskFit: number;
  stability: number;
  tierPriority: number;
  tierAffinity: number;
  specificityMatch: number;
  contextAffinity: number;
  resetWindowAffinity: number;
  connectionDensity: number;
}

export interface ScoringWeights {
  quota: number;
  health: number;
  costInv: number;
  latencyInv: number;
  taskFit: number;
  stability: number;
  tierPriority: number;
  tierAffinity: number;
  specificityMatch: number;
  contextAffinity: number;
  resetWindowAffinity: number;
  connectionDensity: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  quota: 0.15,
  health: 0.2,
  costInv: 0.15,
  latencyInv: 0.12,
  taskFit: 0.08,
  stability: 0.05,
  tierPriority: 0.05,
  tierAffinity: 0.05,
  specificityMatch: 0.05,
  contextAffinity: 0.05,
  resetWindowAffinity: 0,
  connectionDensity: 0.05,
};

export interface ProviderCandidate {
  provider: string;
  model: string;
  quotaRemaining: number; // percentage 0..100
  quotaTotal: number;
  circuitBreakerState: "CLOSED" | "HALF_OPEN" | "OPEN";
  costPer1MTokens: number;
  p95LatencyMs: number;
  latencyStdDev: number;
  errorRate: number;
  /** T10: Optional account tier for priority boosting (Ultra > Pro > Free) */
  accountTier?: "ultra" | "pro" | "standard" | "free";
  /** T10: Optional quota reset interval in seconds (shorter = higher priority when same quota) */
  quotaResetIntervalSecs?: number;
  /** Score [0..1] for staying on the current session's provider/account/model path. */
  contextAffinity?: number;
  /** Score [0..1] for quota reset-window preference; sooner selected reset windows score higher. */
  resetWindowAffinity?: number;
  connectionPoolSize?: number;
  connectionId?: string;
}

export interface ScoredProvider {
  provider: string;
  model: string;
  score: number;
  factors: ScoringFactors;
  connectionId?: string;
}
