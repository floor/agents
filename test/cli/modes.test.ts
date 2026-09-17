import { expect, test, describe } from 'bun:test'
import { pipelinesFor, pipelinesLabel } from '../../src/cli/modes.ts'

const implementer = { capabilities: ['read_code', 'write_code', 'create_pr'] as const }
const reviewer = { capabilities: ['read_code', 'review_pr'] as const }
const voter = { capabilities: ['review_rfc', 'vote'] as const }
const externalVoter = { ...voter, external: true }
const externalWriter = { capabilities: ['write_code'] as const, external: true }
const pm = { capabilities: ['decompose_task'] as const }

describe('pipelinesFor', () => {
  test('implementers alone run development only', () => {
    expect(pipelinesFor([implementer, reviewer])).toEqual({ development: true, committee: false })
  })

  test('voters alone run the committee only, as before', () => {
    expect(pipelinesFor([voter, externalVoter])).toEqual({ development: false, committee: true })
  })

  test('implementers and voters in one manifest run both', () => {
    expect(pipelinesFor([implementer, reviewer, voter, externalVoter])).toEqual({ development: true, committee: true })
  })

  test('an external writer does not bring development: it cannot run in-process', () => {
    expect(pipelinesFor([externalWriter, voter])).toEqual({ development: false, committee: true })
  })

  test('a manifest with no voters still runs development without an implementer', () => {
    expect(pipelinesFor([pm])).toEqual({ development: true, committee: false })
  })
})

describe('pipelinesLabel', () => {
  test('names each pipeline that runs', () => {
    expect(pipelinesLabel({ development: true, committee: false })).toBe('dev')
    expect(pipelinesLabel({ development: false, committee: true })).toBe('committee')
    expect(pipelinesLabel({ development: true, committee: true })).toBe('dev + committee')
  })
})
