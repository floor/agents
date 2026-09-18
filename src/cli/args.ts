export type CliArgs = {
  readonly command: 'watch' | 'init' | 'doctor' | 'run' | 'verify' | 'review' | 'status' | 'help' | 'version'
  readonly config?: string
  readonly issue?: string
  /** `run` only: archive a failed attempt and start over. */
  readonly retry?: boolean
}

export function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help' }
  if (argv.includes('--version') || argv.includes('-v')) return { command: 'version' }
  let command: CliArgs['command'] = 'watch'
  let hasCommand = false
  let config: string | undefined
  let issue: string | undefined
  let retry = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (['watch', 'init', 'doctor', 'run', 'verify', 'review', 'status'].includes(arg) && !hasCommand) {
      command = arg as CliArgs['command']
      hasCommand = true
    } else if (arg === '--config' || arg === '--issue') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
      if (arg === '--config') config = value
      else issue = value
    } else if (arg === '--retry') {
      retry = true
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (command === 'run' && !issue) throw new Error('Usage: floor-agents run --issue <id> [--config <path>]')
  if (command === 'verify' && !issue) throw new Error('Usage: floor-agents verify --issue <id> [--config <path>]')
  if (command === 'review' && !issue) throw new Error('Usage: floor-agents review --issue <id> [--config <path>]')
  if (command === 'status' && !issue) throw new Error('Usage: floor-agents status --issue <id> [--config <path>]')
  if (issue && !['run', 'verify', 'review', 'status'].includes(command)) throw new Error('--issue is only supported with run, verify, review and status')
  if (retry && command !== 'run') throw new Error('--retry is only supported with run')
  return { command, config, issue, ...(retry ? { retry } : {}) }
}
