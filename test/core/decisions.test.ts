import { test, expect, describe } from 'bun:test'
import { decide, decisionPolicy, resolveQuorum, resolveRounds, DEFAULT_DECISIONS } from '@floor-agents/core'
import type { DecisionPolicy, Verdict } from '@floor-agents/core'

const approve = (agent: string, blockers: string[] = []): Verdict => ({ agent, decision: 'approve', blockers })
const changes = (agent: string, blockers: string[] = []): Verdict => ({ agent, decision: 'changes', blockers })
const abstain = (agent: string, blockers: string[] = []): Verdict => ({ agent, decision: 'abstain', blockers })

function run(policy: DecisionPolicy, verdicts: Verdict[], extra: { lead?: Verdict; human?: { id: string; decision: 'approve' | 'changes' } } = {}) {
  return decide({ kind: 'pr-review', policy, verdicts, ...extra })
}

describe('lead', () => {
  const policy: DecisionPolicy = { mode: 'lead' }

  test('the lead approves', () => {
    const out = run(policy, [changes('a', ['x']), changes('b')], { lead: approve('lead') })
    expect(out).toMatchObject({ result: 'approve', decidedBy: 'lead' })
  })

  test('the lead requests changes, with its own blockers only', () => {
    const out = run(policy, [approve('a', ['team note'])], { lead: changes('lead', ['fix it']) })
    expect(out).toMatchObject({ result: 'changes', decidedBy: 'lead', blockers: ['fix it'] })
  })

  test('no lead verdict is no decision, whatever the team said', () => {
    const out = run(policy, [approve('a'), approve('b'), approve('c')])
    expect(out).toMatchObject({ result: 'no-decision', decidedBy: 'none', blockers: [] })
  })

  test('a lead that abstains is no decision', () => {
    expect(run(policy, [approve('a')], { lead: abstain('lead') }).result).toBe('no-decision')
  })
})

describe('lead-with-advisors', () => {
  const policy: DecisionPolicy = { mode: 'lead-with-advisors' }

  test('advisors\' blockers are reported but do not override the lead', () => {
    const out = run(policy, [changes('a', ['race in init']), approve('b', ['typo'])], { lead: approve('lead') })
    expect(out).toMatchObject({ result: 'approve', decidedBy: 'lead', blockers: ['race in init', 'typo'] })
  })

  test('the lead\'s blockers come first and duplicates are dropped', () => {
    const out = run(policy, [changes('a', ['shared', 'a only'])], { lead: changes('lead', ['shared']) })
    expect(out).toMatchObject({ result: 'changes', blockers: ['shared', 'a only'] })
  })

  test('only the policy\'s voters are heard as advisors', () => {
    const out = run({ ...policy, voters: ['a'] }, [changes('a', ['kept']), changes('b', ['dropped'])], { lead: approve('lead') })
    expect(out.blockers).toEqual(['kept'])
  })

  test('no lead is no decision; the advisors\' blockers are still reported', () => {
    const out = run(policy, [changes('a', ['x'])])
    expect(out).toMatchObject({ result: 'no-decision', decidedBy: 'none', blockers: ['x'] })
  })

  test('a lead that abstains is no decision', () => {
    expect(run(policy, [approve('a'), approve('b')], { lead: abstain('lead') }).result).toBe('no-decision')
  })
})

describe('majority', () => {
  const policy: DecisionPolicy = { mode: 'majority' }

  test('a strict majority approves', () => {
    expect(run(policy, [approve('a'), approve('b'), changes('c')])).toMatchObject({ result: 'approve', decidedBy: 'team' })
  })

  test('a tie requests changes', () => {
    expect(run(policy, [approve('a'), changes('b')]).result).toBe('changes')
  })

  test('a majority of changes requests changes', () => {
    expect(run(policy, [approve('a'), changes('b'), changes('c')]).result).toBe('changes')
  })

  test('blockers do not veto, and are reported', () => {
    const out = run(policy, [approve('a', ['nit']), approve('b'), changes('c', ['bug'])])
    expect(out).toMatchObject({ result: 'approve', blockers: ['nit', 'bug'] })
  })

  test('default quorum is two cast verdicts; abstentions do not count', () => {
    expect(run(policy, [approve('a'), abstain('b'), abstain('c')])).toMatchObject({ result: 'no-decision', decidedBy: 'none' })
    expect(run(policy, [approve('a'), approve('b'), abstain('c')]).result).toBe('approve')
  })

  test('abstentions do not dilute the majority', () => {
    expect(run(policy, [approve('a'), approve('b'), abstain('c'), abstain('d'), abstain('e')]).result).toBe('approve')
  })

  test('quorum edges', () => {
    expect(run({ ...policy, quorum: 1 }, [approve('a')]).result).toBe('approve')
    expect(run({ ...policy, quorum: 1 }, []).result).toBe('no-decision')
    expect(run({ ...policy, quorum: 3 }, [approve('a'), approve('b')]).result).toBe('no-decision')
    expect(run({ ...policy, quorum: 3 }, [approve('a'), approve('b'), changes('c')]).result).toBe('approve')
  })

  test('only the policy\'s voters count', () => {
    const out = run({ ...policy, voters: ['a', 'b'] }, [approve('a'), approve('b'), changes('c'), changes('d'), changes('e')])
    expect(out.result).toBe('approve')
    expect(run({ ...policy, voters: ['a'] }, [approve('a'), approve('b')]).result).toBe('no-decision')
  })

  test('the lead is not a voter in a team mode', () => {
    expect(run(policy, [approve('a')], { lead: approve('lead') }).result).toBe('no-decision')
  })
})

describe('unanimous', () => {
  const policy: DecisionPolicy = { mode: 'unanimous' }

  test('every cast verdict approves', () => {
    expect(run(policy, [approve('a'), approve('b'), abstain('c')]).result).toBe('approve')
  })

  test('one dissent requests changes', () => {
    expect(run(policy, [approve('a'), approve('b'), approve('c'), changes('d')]).result).toBe('changes')
  })

  test('blockers on approvals do not stop it; they are reported', () => {
    expect(run(policy, [approve('a', ['nit']), approve('b')])).toMatchObject({ result: 'approve', blockers: ['nit'] })
  })

  test('below quorum is no decision', () => {
    expect(run(policy, [approve('a'), abstain('b')]).result).toBe('no-decision')
    expect(run({ ...policy, quorum: 1 }, [approve('a'), abstain('b')]).result).toBe('approve')
  })
})

describe('veto', () => {
  const policy: DecisionPolicy = { mode: 'veto' }

  test('a strict majority with no blockers approves', () => {
    expect(run(policy, [approve('a'), approve('b'), changes('c')])).toMatchObject({ result: 'approve', decidedBy: 'team', blockers: [] })
  })

  test('any blocker vetoes a majority', () => {
    const out = run(policy, [approve('a'), approve('b'), approve('c', ['missing test'])])
    expect(out).toMatchObject({ result: 'changes', decidedBy: 'team', blockers: ['missing test'] })
    expect(out.reason).toContain('Vetoed')
  })

  test('a blocker from a finished review whose vote was not read still vetoes', () => {
    expect(run(policy, [approve('a'), approve('b'), abstain('c', ['leak'])]).result).toBe('changes')
  })

  test('a tie requests changes', () => {
    expect(run(policy, [approve('a'), changes('b')]).result).toBe('changes')
  })

  test('below quorum is no decision, blockers or not', () => {
    expect(run(policy, [changes('a', ['x']), abstain('b')])).toMatchObject({ result: 'no-decision', blockers: ['x'] })
  })
})

describe('human', () => {
  const policy: DecisionPolicy = { mode: 'human', humans: ['jvial'] }

  test('a listed person decides', () => {
    expect(run(policy, [changes('a')], { human: { id: 'jvial', decision: 'approve' } })).toMatchObject({ result: 'approve', decidedBy: 'human' })
    expect(run(policy, [], { human: { id: 'jvial', decision: 'changes' } })).toMatchObject({ result: 'changes', decidedBy: 'human' })
  })

  test('nobody has decided: needs a person', () => {
    expect(run(policy, [approve('a'), approve('b')])).toMatchObject({ result: 'needs-human', decidedBy: 'none' })
  })

  test('a person not on the list does not decide', () => {
    const out = run(policy, [], { human: { id: 'someone', decision: 'approve' } })
    expect(out).toMatchObject({ result: 'needs-human', decidedBy: 'none' })
    expect(out.reason).toContain('someone')
  })

  test('without a list, any person decides', () => {
    expect(run({ mode: 'human' }, [], { human: { id: 'anyone', decision: 'approve' } }).result).toBe('approve')
  })

  test('the agents\' blockers are reported to the person', () => {
    expect(run(policy, [changes('a', ['x'])], { lead: changes('lead', ['y']) }).blockers).toEqual(['y', 'x'])
  })
})

test('an unknown mode decides nothing', () => {
  const policy = { mode: 'coin-flip' } as unknown as DecisionPolicy
  expect(run(policy, [approve('a'), approve('b')])).toMatchObject({ result: 'no-decision', decidedBy: 'none' })
})

describe('policy helpers', () => {
  test('defaults reproduce today\'s rules', () => {
    expect(DEFAULT_DECISIONS['pr-review']).toEqual({ mode: 'veto', quorum: 2, rounds: 3 })
    expect(DEFAULT_DECISIONS['rfc']).toEqual({ mode: 'majority', quorum: 1 })
  })

  test('rounds and quorum fall back to 3 and 2', () => {
    expect(resolveRounds({ mode: 'veto' })).toBe(3)
    expect(resolveRounds({ mode: 'veto', rounds: 5 })).toBe(5)
    expect(resolveQuorum({ mode: 'majority' })).toBe(2)
    expect(resolveQuorum({ mode: 'majority', quorum: 1 })).toBe(1)
  })

  test('a manifest policy wins over the default; an unnamed kind has none', () => {
    expect(decisionPolicy('pr-review')).toEqual(DEFAULT_DECISIONS['pr-review']!)
    expect(decisionPolicy('pr-review', { 'pr-review': { mode: 'majority' } })).toEqual({ mode: 'majority' })
    expect(decisionPolicy('rfc', { 'pr-review': { mode: 'majority' } })).toEqual(DEFAULT_DECISIONS['rfc']!)
    expect(decisionPolicy('publish')).toBeUndefined()
  })
})
