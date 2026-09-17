/**
 * The orchestrator agent — an LLM reasoning loop that conducts the engine's
 * worker capabilities (inspect, execute, review, verify) as tools, under
 * guardrails that make it safe to run unattended.
 *
 * This module is the net-new "conductor" the engine lacked. The two load-bearing
 * guardrails are implemented as a pure function (`applyGuards`) so they are
 * directly testable and ENFORCED in the tool handler — the model cannot bypass
 * them no matter what it claims:
 *
 *   - ground-before-act: an `act` tool is refused until something was inspected.
 *   - objective-verification: `done` is refused unless the latest `verify` PASSED,
 *     and any `act` invalidates a prior pass (a code change forces a re-verify).
 *
 * The remaining guardrails (human approval, escalation, budget/step caps) layer on
 * top; see docs/orchestrator-agent.md.
 */

import type { AgentDefinition, ToolDefinition, ToolCall, LLMMessage } from '@floor-agents/core'
import { runToolUseLoop, type LLMAdapterResolver, type LLMRunResult } from './llm-runner.ts'

/** Classifies a tool for the guardrail policy. */
export type ToolKind = 'inspect' | 'act' | 'verify' | 'done' | 'report'

/** Minimal state the two guardrails track across a run. */
export type GuardState = {
  /** Has the agent inspected (grounded) at least once? */
  readonly inspected: boolean
  /** Did the most recent `verify` pass? Reset to false by any `act`. */
  readonly lastVerifyPassed: boolean
}

export const initialGuardState = (): GuardState => ({ inspected: false, lastVerifyPassed: false })

export type GuardDecision = {
  readonly allowed: boolean
  readonly reason?: string
  readonly next: GuardState
}

/**
 * The two net-new guardrails, as a pure function (no LLM, no IO).
 *
 * For `verify`, pass the OBJECTIVE result (`verifyPassed` from the tool's exit
 * code / test outcome) — never the model's assertion.
 */
export function applyGuards(state: GuardState, kind: ToolKind, verifyPassed?: boolean): GuardDecision {
  // ── ground-before-act ──
  if (kind === 'act' && !state.inspected) {
    return {
      allowed: false,
      reason: 'ground-before-act: inspect the repository before changing anything.',
      next: state,
    }
  }
  // ── objective-verification ──
  if (kind === 'done' && !state.lastVerifyPassed) {
    return {
      allowed: false,
      reason: 'objective-verification: cannot finish until verify() passes (tests / typecheck / build green).',
      next: state,
    }
  }
  // ── allowed-call state transitions ──
  if (kind === 'inspect') return { allowed: true, next: { ...state, inspected: true } }
  if (kind === 'verify') return { allowed: true, next: { ...state, lastVerifyPassed: verifyPassed === true } }
  // a code change invalidates any prior verification — must re-verify before done
  if (kind === 'act') return { allowed: true, next: { ...state, lastVerifyPassed: false } }
  return { allowed: true, next: state } // report, or an allowed `done`
}

/** A tool the orchestrator agent can call. */
export type OrchestratorTool = {
  readonly def: ToolDefinition
  readonly kind: ToolKind
  /**
   * Execute the tool. For a `verify` tool, return `verifyPassed` derived from the
   * objective result (exit code / test outcome), not from any model claim.
   */
  readonly run: (input: Record<string, unknown>) => Promise<{ output: string; verifyPassed?: boolean }>
}

export type OrchestratorAgentDeps = {
  readonly agent: AgentDefinition
  readonly getAdapter: LLMAdapterResolver
  readonly tools: readonly OrchestratorTool[]
  readonly systemPrompt?: string
}

export type OrchestratorRunResult = LLMRunResult & {
  readonly guard: GuardState
  /** Tool calls the guardrails refused, for transparency / debugging. */
  readonly blockedCalls: ReadonlyArray<{ readonly tool: string; readonly reason: string }>
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are the orchestrator. You drive a task to completion by calling tools.',
  '',
  'Discipline (enforced — calls that violate it are rejected, so cooperate):',
  '- Ground first: call an inspect tool to understand the code before changing anything.',
  '- Change via act tools, then run verify (tests / typecheck / build).',
  '- You may only finish when verify has PASSED. A change after a passing verify',
  '  requires you to verify again. Do not claim success — only a passing verify counts.',
  '- For irreversible or outward actions, request human approval.',
].join('\n')

/**
 * Create an orchestrator agent. Returns `run(goal)` which drives the reasoning
 * loop with guardrails enforced in the tool handler.
 */
export function createOrchestratorAgent(deps: OrchestratorAgentDeps): {
  run(goal: string): Promise<OrchestratorRunResult>
} {
  const byName = new Map(deps.tools.map(t => [t.def.name, t]))

  return {
    async run(goal: string): Promise<OrchestratorRunResult> {
      let guard = initialGuardState()
      const blockedCalls: { tool: string; reason: string }[] = []

      const handler = async (tc: ToolCall): Promise<string> => {
        const tool = byName.get(tc.name)
        if (!tool) return `error: unknown tool "${tc.name}"`

        // verify must run first to learn the objective result, then update state.
        if (tool.kind === 'verify') {
          const { output, verifyPassed } = await tool.run(tc.input)
          guard = applyGuards(guard, 'verify', verifyPassed).next
          return `${output}\n[verify: ${verifyPassed ? 'PASSED' : 'FAILED'}]`
        }

        const decision = applyGuards(guard, tool.kind)
        if (!decision.allowed) {
          blockedCalls.push({ tool: tc.name, reason: decision.reason! })
          return `[guardrail blocked] ${decision.reason}`
        }
        guard = decision.next
        const { output } = await tool.run(tc.input)
        return output
      }

      const messages: LLMMessage[] = [{ role: 'user', content: goal }]
      const result = await runToolUseLoop(
        deps.agent,
        deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        messages,
        deps.tools.map(t => t.def),
        deps.getAdapter,
        handler,
      )

      return { ...result, guard, blockedCalls }
    },
  }
}
