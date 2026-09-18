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

  test('serve is the API alone: no issue', () => {
    expect(parseArgs(['serve', '--config', 'a.yaml'])).toEqual({ command: 'serve', config: 'a.yaml', issue: undefined })
    expect(() => parseArgs(['serve', '--issue', 'FLO-1'])).toThrow('--issue is only supported with')
  })

  test('review takes one issue', () => {
    expect(parseArgs(['review', '--issue', 'FLO-96'])).toEqual({ command: 'review', config: undefined, issue: 'FLO-96' })
    expect(() => parseArgs(['review'])).toThrow('Usage: floor-agents review --issue')
  })

  test('verify takes one issue', () => {
    expect(parseArgs(['verify', '--issue', 'FLO-191'])).toEqual({ command: 'verify', config: undefined, issue: 'FLO-191' })
    expect(() => parseArgs(['verify'])).toThrow('Usage: floor-agents verify --issue')
  })

  test('status reads one issue', () => {
    expect(parseArgs(['status', '--issue', 'FLO-191'])).toEqual({ command: 'status', config: undefined, issue: 'FLO-191' })
    expect(() => parseArgs(['status'])).toThrow('Usage: floor-agents status --issue')
    expect(() => parseArgs(['doctor', '--issue', 'FLO-1'])).toThrow('--issue is only supported with run, verify, review and status')
  })

  test('no command means watch', () => {
    expect(parseArgs([])).toEqual({ command: 'watch', config: undefined, issue: undefined })
  })
})
