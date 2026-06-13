import { test, expect } from 'bun:test'
import { loadCompanyConfig, validateCompanyConfig } from '@floor-agents/core'

// Guards every shipped config template against validation regressions —
// e.g. the committee template previously shipped guardrails set to 0, which
// the validator rejects. Paths are relative to the repo root (tests run there).
const TEMPLATES = [
  'config/templates/committee.yaml',
  'config/templates/default.yaml',
] as const

for (const path of TEMPLATES) {
  test(`shipped template validates with zero errors: ${path}`, async () => {
    const company = await loadCompanyConfig(path)
    const errors = validateCompanyConfig(company)

    expect(errors).toEqual([])
  })
}
