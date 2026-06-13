#!/usr/bin/env bun
/**
 * Antigravity MCP bridge (file-backed). The stdio MCP server Antigravity spawns.
 * Holds NO gateway connection — the persistent antigravity-relay.ts owns that and
 * exchanges work through the shared ~/.floor-committee dir, so this server is
 * race-free and safe to lazy-spawn:
 *   - get_pending_review()          → next RFC awaiting review   (reads pending/)
 *   - submit_vote(taskId, content)  → record the vote            (writes results/)
 *
 * Tool logic lives in lib/mcp-tools.ts (testable); this is the runnable entry point.
 */

// MCP speaks JSON-RPC over stdout — route any stray logging to stderr.
console.log = (...args: unknown[]) => console.error(...args)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { committeeFiles } from './lib/committee-files.ts'
import { getPendingReviewText, submitVote } from './lib/mcp-tools.ts'

const files = committeeFiles()
const server = new McpServer({ name: 'floor-committee', version: '2.0.0' })

server.registerTool(
  'get_pending_review',
  {
    description:
      "Return the next RFC awaiting Antigravity's committee review (or a message if none). " +
      'Review it from the browser-engine perspective, then call submit_vote.',
    inputSchema: {},
  },
  async () => ({ content: [{ type: 'text' as const, text: getPendingReviewText(files) }] }),
)

server.registerTool(
  'submit_vote',
  {
    description:
      "Submit Antigravity's committee review and vote for a pending RFC. " +
      'content must end with **VOTE: APPROVE** or **VOTE: REJECT**.',
    inputSchema: { taskId: z.string(), content: z.string() },
  },
  async ({ taskId, content }) => {
    submitVote(files, taskId, content)
    console.error(`[antigravity-mcp] recorded vote for ${taskId} (${content.length} chars)`)
    return { content: [{ type: 'text' as const, text: `Vote submitted for ${taskId}.` }] }
  },
)

await server.connect(new StdioServerTransport())
console.error('[antigravity-mcp] file-backed bridge ready')
