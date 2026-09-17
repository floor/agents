/**
 * TelegramChannel — a TeamChannel backed by a Telegram bot. Zero dependencies
 * (pure `fetch` to api.telegram.org). The shared team bus: agent turns stream in
 * as messages, the human reads on their phone and can interject, and approval
 * gates use inline buttons.
 *
 * The HTTP layer is an injectable `transport` so the whole thing is unit-testable
 * without a real bot token. Security: only the user ids in `allowFrom` may interject
 * or approve. With no allowlist, only the bot's private chat is trusted — a group
 * deployment must name its operators, because a group update carries the same
 * chat id for every member and so cannot identify who spoke.
 */

import type { TeamChannel, TeamMessage, Decision } from './team-channel.ts'

// ── Minimal Telegram API shapes (only what we use) ──────────────────
type TgUser = { readonly id: number }
type TgChat = { readonly id: number }
type TgMessage = { readonly message_id: number; readonly from?: TgUser; readonly chat: TgChat; readonly text?: string }
type TgCallbackQuery = { readonly id: string; readonly from: TgUser; readonly data?: string; readonly message?: { readonly chat: TgChat } }
type TgUpdate = { readonly update_id: number; readonly message?: TgMessage; readonly callback_query?: TgCallbackQuery }
type TgResponse<T> = { readonly ok: boolean; readonly result?: T; readonly description?: string }

/** POST a Telegram Bot API method; returns the parsed response. Injectable for tests. */
export type TelegramTransport = (method: string, payload: Record<string, unknown>) => Promise<TgResponse<unknown>>

export type TelegramChannelConfig = {
  readonly token: string
  /** Where agent turns are posted. */
  readonly chatId: string | number
  /**
   * User ids permitted to interject / approve. Omit ONLY for a private chat with the
   * bot; in a group, every member's messages carry the group's chat id, so without
   * this list the channel refuses everyone rather than trusting everyone.
   */
  readonly allowFrom?: ReadonlyArray<string | number>
  /** Override the HTTP layer (tests). Defaults to `fetch` against api.telegram.org. */
  readonly transport?: TelegramTransport
  /** Poll interval while waiting on an approval (ms). */
  readonly pollIntervalMs?: number
  /** Timeout for an approval gate (ms). */
  readonly decisionTimeoutMs?: number
  readonly log?: (msg: string) => void
}

const TELEGRAM_MAX = 4096
const CHUNK = 3800 // leave room for an author prefix under the 4096 limit

function defaultTransport(token: string): TelegramTransport {
  return async (method, payload) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return (await res.json()) as TgResponse<unknown>
  }
}

function chunk(text: string): string[] {
  if (text.length <= CHUNK) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK))
  return parts
}

export function createTelegramChannel(config: TelegramChannelConfig): TeamChannel {
  const transport = config.transport ?? defaultTransport(config.token)
  const log = config.log ?? (() => {})
  const pollMs = config.pollIntervalMs ?? 2000
  const decisionTimeout = config.decisionTimeoutMs ?? 30 * 60_000
  const allow = config.allowFrom ? new Set(config.allowFrom.map(String)) : null

  // Shared update cursor — Telegram delivers each update once; we route messages
  // to the human queue and callback taps to the callback queue.
  let offset = 0
  const humanQueue: TeamMessage[] = []
  const callbacks: { data: string; queryId: string }[] = []

  /**
   * Authorize the SENDER, not the chat. Input must come from the configured chat AND
   * be written by an allowlisted user. With no allowlist we trust only the bot's
   * private chat (Telegram sets chat.id === from.id there); a group therefore fails
   * closed until its operators are named. Human input is folded verbatim into the
   * agents' next prompt, so this is the boundary on who can steer a run.
   */
  const allowed = (chatId: number | undefined, fromId: number | undefined): boolean => {
    if (chatId === undefined || fromId === undefined) return false
    if (String(chatId) !== String(config.chatId)) return false
    const ok = allow ? allow.has(String(fromId)) : String(chatId) === String(fromId)
    if (!ok) log(`ignored input from user ${fromId} in chat ${chatId} — not in allowFrom`)
    return ok
  }

  async function pull(): Promise<void> {
    const res = (await transport('getUpdates', { offset, timeout: 0 })) as TgResponse<TgUpdate[]>
    if (!res.ok || !res.result) {
      if (!res.ok) log(`getUpdates not ok: ${res.description ?? 'unknown'}`)
      return
    }
    for (const u of res.result) {
      offset = Math.max(offset, u.update_id + 1)
      const m = u.message
      if (m?.text && allowed(m.chat.id, m.from?.id)) humanQueue.push({ from: 'Human', text: m.text })
      const cq = u.callback_query
      if (cq?.data && allowed(cq.message?.chat.id, cq.from.id)) {
        callbacks.push({ data: cq.data, queryId: cq.id })
      }
    }
  }

  return {
    async post(from: string, text: string): Promise<void> {
      const parts = chunk(text)
      for (let i = 0; i < parts.length; i++) {
        const prefix = i === 0 ? `🤖 ${from}:\n` : ''
        const res = await transport('sendMessage', {
          chat_id: config.chatId,
          text: `${prefix}${parts[i]}`.slice(0, TELEGRAM_MAX),
        })
        // A revoked token or blocked chat must not look like a delivered message.
        if (!res.ok) log(`sendMessage failed: ${res.description ?? 'unknown'}`)
      }
    },

    async drainHumanMessages(): Promise<TeamMessage[]> {
      await pull()
      const drained = humanQueue.splice(0, humanQueue.length)
      return drained
    },

    async awaitDecision(taskId: string, prompt: string): Promise<Decision> {
      const sent = await transport('sendMessage', {
        chat_id: config.chatId,
        text: prompt,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${taskId}` },
            { text: '✏️ Request changes', callback_data: `changes:${taskId}` },
          ]],
        },
      })
      // If the prompt never arrived, nobody can tap it — fail closed now rather than
      // block for the full timeout waiting on a button that does not exist.
      if (!sent.ok) {
        const why = sent.description ?? 'unknown'
        log(`approval prompt not delivered: ${why}`)
        return { approved: false, note: `approval prompt not delivered: ${why}` }
      }

      const deadline = Date.now() + decisionTimeout
      for (;;) {
        await pull()
        const idx = callbacks.findIndex(c => c.data === `approve:${taskId}` || c.data === `changes:${taskId}`)
        if (idx !== -1) {
          const hit = callbacks.splice(idx, 1)[0]!
          await transport('answerCallbackQuery', { callback_query_id: hit.queryId })
          return { approved: hit.data.startsWith('approve:') }
        }
        if (Date.now() >= deadline) return { approved: false, note: 'approval timed out' }
        await new Promise(r => setTimeout(r, pollMs))
      }
    },
  }
}
