import { describe, expect, test } from 'bun:test'
import { linearScope } from '../../src/cli/linear-scope.ts'

describe('linearScope', () => {
  const mtrl = { tasks: { source: 'linear' as const, linear: { team: 'FLO', project: 'mtrl' } } }

  test('the manifest’s project wins over the environment of the folder the engine was started from', () => {
    // Measured: the mtrl engine, started from the agents folder, listed the agents project's backlog.
    expect(linearScope(mtrl, { LINEAR_PROJECT_ID: 'the-agents-project' })).toEqual({ projectName: 'mtrl' })
  })

  test('the environment is the fallback for a manifest that names no project', () => {
    expect(linearScope({ tasks: { source: 'linear' as const } }, { LINEAR_PROJECT_ID: 'p-1' })).toEqual({ projectId: 'p-1' })
    expect(linearScope({}, { LINEAR_PROJECT_ID: 'p-1' })).toEqual({ projectId: 'p-1' })
  })

  test('neither: the whole team, as before', () => {
    expect(linearScope({}, {})).toEqual({})
  })
})
