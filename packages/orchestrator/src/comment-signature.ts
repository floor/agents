/**
 * Who is speaking, on every comment a run posts.
 *
 * The engine writes through one GitHub token, so every comment carries the
 * account's name and nothing else: a reader cannot tell an agent's turn from a
 * person's message. Each comment therefore ends with a signature naming the
 * agent, its model and its transport, and saying the run was automated.
 *
 * It is a wrapper rather than 28 edited call sites: a new comment cannot be
 * added unsigned.
 */

import type { TaskAdapter, AgentDefinition } from '@floor-agents/core'

export type Signable = Pick<AgentDefinition, 'name' | 'llm'>

/**
 * The agent as a person reads it: `Grok 4.6 high`, not `cursor-grok-4.6-high`.
 *
 * A model id carries its transport (`cursor-`) and repeats the vendor the agent
 * is already named after, so both are dropped and what is left — the family and
 * the effort — follows the name.
 */
export function agentLabel(agent: Signable): string {
  const parts = agent.llm.model.split('-').filter(p => p && p !== agent.llm.provider)
  const rest = parts
    .filter(p => p.toLowerCase() !== agent.name.toLowerCase())
    // A pinned model carries its release date (claude-opus-4-1-20250805); the
    // family and version identify it, the date only lengthens the line.
    .filter(p => !/^\d{8}$/.test(p))
    // "4", "1" were one version before the id split them: 4.1, not "4 1".
    .reduce<string[]>((acc, p) => {
      const last = acc[acc.length - 1]
      if (last !== undefined && /^\d+$/.test(last) && /^\d+$/.test(p)) acc[acc.length - 1] = `${last}.${p}`
      else acc.push(p)
      return acc
    }, [])
  if (rest.length === 0) return agent.name
  // "gpt" is an acronym and "opus" a word; a version keeps its own shape.
  const word = (w: string): string =>
    /\d/.test(w) ? w : w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)
  return `${agent.name} ${[word(rest[0]!), ...rest.slice(1)].join(' ')}`
}

/** `— **Agent:** Grok 4.6 high · automated by Floor Agents` */
export function agentSignature(agent: Signable): string {
  return `— **Agent:** ${agentLabel(agent)} · automated by Floor Agents`
}

/** For the engine's own turns, which belong to no single agent. */
export const ENGINE_SIGNATURE = '— **Floor Agents** · automated run, not a person'

/** Append the signature, unless this text already carries one. */
export function sign(text: string, signature: string): string {
  return text.trimEnd().endsWith(signature) ? text : `${text.trimEnd()}\n\n${signature}`
}

/**
 * The same adapter, with every comment signed.
 *
 * A proxy rather than a spread: the committee harnesses pass adapters holding
 * only the methods they use, and copying the object dropped the rest — a
 * partial adapter went in and a broken one came out.
 */
export function signComments(adapter: TaskAdapter, signature: string): TaskAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'addComment') {
        return (issueId: string, text: string) => target.addComment(issueId, sign(text, signature))
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
