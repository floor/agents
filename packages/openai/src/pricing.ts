type ModelPricing = {
  readonly inputPerMillion: number
  readonly outputPerMillion: number
}

const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4-turbo': { inputPerMillion: 10, outputPerMillion: 30 },
  'o3': { inputPerMillion: 10, outputPerMillion: 40 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
}

// Local models (LM Studio, Ollama) have no cost
const FREE_PRICING: ModelPricing = { inputPerMillion: 0, outputPerMillion: 0 }
const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 2.5, outputPerMillion: 10 }

export function estimateCost(model: string, inputTokens: number, outputTokens: number, isLocal: boolean): number {
  if (isLocal) return 0

  const pricing = PRICING[model] ?? DEFAULT_PRICING
  return (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000
}
