import { describe, expect, test } from 'bun:test'
import { AgentStopped, GateExhausted, crashReport, gateExhaustedReport, stopReport, writtenSummary } from '../../packages/orchestrator/src/stop-report.ts'

describe('writtenSummary', () => {
  test('joins the diff stat with the new files git diff does not see', () => {
    const out = writtenSummary(' src/core/runway.ts | 13 ++++++++++++-\n 1 file changed, 12 insertions(+), 1 deletion(-)\n', 'test/core/fold.test.ts\n')
    expect(out).toBe(' src/core/runway.ts | 13 ++++++++++++-\n 1 file changed, 12 insertions(+), 1 deletion(-)\n new: test/core/fold.test.ts')
  })

  test('is empty when nothing was written', () => {
    expect(writtenSummary('', '\n')).toBe('')
  })
})

describe('stopReport', () => {
  test('names the budget, shows the work, and says how to retry', () => {
    const text = stopReport('Grok', 'cursor agent did not finish within 10 minutes (raise the agent\'s timeoutMs in the manifest)', ' src/core/runway.ts | 13 +', 'FLO-163')
    expect(text).toContain('⏱ **Grok** stopped: cursor agent did not finish within 10 minutes')
    expect(text).toContain('Written before the stop, uncommitted:')
    expect(text).toContain('```\n src/core/runway.ts | 13 +\n```')
    expect(text).toContain('floor-agents run --issue FLO-163 --retry')
  })

  test('says so when nothing was written, without an empty code block', () => {
    const text = stopReport('Grok', 'capped', '', 'FLO-163')
    expect(text).toContain('Nothing was written before the stop.')
    expect(text).not.toContain('```')
  })

  test('a crash reads as a run failure, not as the agent speaking', () => {
    expect(crashReport('boom', '42')).toStartWith('❌ **Run failed**')
    expect(crashReport('boom', '42')).toContain('--issue 42 --retry')
  })

  test('AgentStopped carries the written summary and is an Error', () => {
    const err = new AgentStopped('capped', 'x | 1 +')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AgentStopped')
    expect(err.written).toBe('x | 1 +')
  })
})

describe('gateExhaustedReport', () => {
  test('names the failing step, shows the tail, and says how to retry', () => {
    const err = new GateExhausted(
      'Verification failed: Tests (exit 1). Logs are in the execution state.',
      { name: 'Tests', command: ['bun', 'test'], exitCode: 1, timedOut: false, durationMs: 10, stdout: 'ok\nFAIL_TOKEN_TAIL', stderr: '' },
      2,
      ' answer.txt | 1 +\n 1 file changed, 1 insertion(+)',
    )
    const text = gateExhaustedReport('Developer', err, 'FLO-191')
    expect(text).toContain('⏱ **Developer** stopped: gate failed after 2 attempts: Tests (exit 1)')
    expect(text).toContain('FAIL_TOKEN_TAIL')
    expect(text).toContain('answer.txt | 1 +')
    expect(text).toContain('floor-agents run --issue FLO-191 --retry')
    expect(text).not.toContain('Run failed')
  })
})
