import { describe, expect, test } from 'bun:test'
import { parseArgs } from '../../src/cli/args.ts'

describe('parseArgs', () => {
  test('run takes an issue and, optionally, --retry', () => {
    expect(parseArgs(['run', '--issue', 'FLO-163'])).toEqual({ command: 'run', config: undefined, issue: 'FLO-163' })
    expect(parseArgs(['run', '--issue', 'FLO-163', '--retry'])).toEqual({ command: 'run', config: undefined, issue: 'FLO-163', retry: true })
  })

  test('--retry belongs to run', () => {
    expect(() => parseArgs(['watch', '--retry'])).toThrow('--retry is only supported with run')
    expect(() => parseArgs(['doctor', '--retry'])).toThrow('--retry is only supported with run')
  })

  test('run without an issue is a usage error', () => {
    expect(() => parseArgs(['run', '--retry'])).toThrow('Usage: floor-agents run --issue')
  })

  test('no command means watch', () => {
    expect(parseArgs([])).toEqual({ command: 'watch', config: undefined, issue: undefined })
  })
})
