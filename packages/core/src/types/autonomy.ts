// Phase 1: defined only — loaded and validated but not evaluated

import type { AutonomyTier } from './agent.ts'

export type AutonomyMatch = {
  readonly path?: string
  readonly label?: string
  readonly agentId?: string
  readonly action?: string
  readonly revisionCycle?: number
  readonly priority?: string
}

export type AutonomyOverride = {
  readonly match: AutonomyMatch
  readonly tier: AutonomyTier
}

export type AutonomyConfig = {
  readonly default: AutonomyTier
  readonly overrides: readonly AutonomyOverride[]
}
