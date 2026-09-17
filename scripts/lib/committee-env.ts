/**
 * Settings the committee scripts read from the environment, validated in one
 * place so a mistyped value fails before any agent runs rather than after.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

export const expandHome = (p: string): string => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/**
 * The committee sits in the project's own manifest, `<repo>/.agents/agents.yaml`,
 * beside the agents that implement: the members are the agents with the `vote`
 * capability. COMMITTEE_CONFIG overrides the path.
 */
export function committeeConfigPath(repo: string, env: Env = process.env): string {
  return env.COMMITTEE_CONFIG ? expandHome(env.COMMITTEE_CONFIG) : join(expandHome(repo), '.agents', 'agents.yaml')
}

type Candidate = { readonly id: string; readonly capabilities: readonly string[] }

/**
 * The committee for this run: agents that can vote and are named in AGENTS.
 *
 * An empty committee is refused. Deliberating with no members would publish a
 * result no one reached, which is the same failure as a zero-round cap.
 */
export function selectVoters<A extends Candidate>(agents: readonly A[], only: readonly string[], source: string): A[] {
  const voters = agents.filter(a => a.capabilities.includes('vote') && only.includes(a.id))
  if (voters.length === 0) {
    throw new Error(
      `No committee members in ${source}: no agent has the vote capability and an id in AGENTS=${only.join(',')}`,
    )
  }
  return voters
}

/**
 * The deliberation round cap. parseInt would read "three" as NaN and "3x" as 3;
 * a NaN cap runs zero rounds and the script then publishes a verdict nobody
 * reached. Anything but a positive whole number is refused outright.
 */
export function parseMaxRounds(raw: string | undefined, fallback = 3): number {
  if (raw === undefined) return fallback
  const n = Number(raw.trim())
  if (raw.trim() === '' || !Number.isInteger(n) || n < 1) {
    throw new Error(`MAX_ROUNDS must be a positive whole number, got "${raw}"`)
  }
  return n
}

export type TelegramSettings = {
  readonly token: string
  readonly chatId: string
  readonly allowFrom: string[] | undefined
}

/**
 * The Telegram channel's settings, or null when turns must not stream there.
 *
 * A dry run publishes nothing, and a Telegram message is publication: it carries
 * excerpts of private repository analysis off this machine. So DRY_RUN wins over
 * configured credentials.
 */
export function telegramSettings(env: Env, dryRun: boolean): TelegramSettings | null {
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (dryRun || !token || !chatId) return null
  const allowFrom = env.TELEGRAM_ALLOW_FROM?.split(',').map(s => s.trim()).filter(Boolean)
  return { token, chatId, allowFrom }
}
