/**
 * Auto-Combo barrel export
 */
export {
  calculateScore,
  calculateTierScore,
  scorePool,
  validateWeights,
} from "./scoring";
export {
  DEFAULT_WEIGHTS,
  type ScoringWeights,
  type ScoringFactors,
  type ProviderCandidate,
  type ScoredProvider,
} from "./types";
export { getTaskFitness, getTaskTypes } from "./taskFitness";
export { SelfHealingManager, getSelfHealingManager } from "./selfHealing";
export { MODE_PACKS, getModePack, getModePackNames } from "./modePacks";
export {
  selectProvider,
  BudgetExceededError,
  type AutoComboConfig,
  type SelectionResult,
} from "./engine";
