/**
 * Manifest routing integration types.
 */

import type { TierAssignment, ProviderTier } from "./tierTypes";
import type { SpecificityResult, SpecificityLevel } from "./specificityTypes";
import type { ResolvedComboTarget } from "./combo/types.ts";

export type StrategyModifier =
  | "default"
  | "prefer-free"
  | "prefer-cheap"
  | "require-premium"
  | "cost-save"
  | "quality-first";

export interface RoutingHint {
  tierAssignments: Map<string, TierAssignment>;
  specificity: SpecificityResult;
  specificityLevel: SpecificityLevel;
  recommendedMinTier: ProviderTier;
  eligibleTargets: ResolvedComboTarget[];
  overqualifiedTargets: ResolvedComboTarget[];
  underqualifiedTargets: ResolvedComboTarget[];
  strategyModifier: StrategyModifier;
}
