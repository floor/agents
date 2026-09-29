# A lead, a roster and configurable decisions

Status: design, 2026-09-29. Author: Claude (team lead), with Dr Jones.

## Why

The engine has been paused since 2026-09-19 ([polish sprint](./polish-sprint.md)). Its review
committee decided by rules fixed in code: a quorum of two, a strict majority, and a veto for any
blocker from any member, over at most three revision cycles. The only setting was
`review.committee: true | false`. In practice:

- a review cycle lasted as long as its slowest seat (5–9 minutes; the Grok bridge timed out in
  3 of 4 reviews), and with two seats one missing voter meant no decision and one disagreement
  meant a rejection;
- seats swapped sides between cycles, and revisions 2 and 3 never produced an approval;
- nobody owned the outcome: consensus spread the responsibility until no agent held it.

The direct mode that replaced it — one lead who decides, with sub-agents doing well-specified
work and executable checks proving it — merged 27–29 PRs a day. What caught real problems was
not voting but gates: tests, parity checks across frameworks, mutation checks, CI on the merge
commit.

## The model

- **A lead decides and owns the outcome.** It plans, assigns work, weighs other agents' input
  and makes the call, accountable to the humans.
- **Other agents contribute, they do not vote by default.** Implementers write code; reviewers
  and advisors return structured verdicts the lead weighs.
- **The brief is the lead's main product.** An agent from any vendor is efficient when its
  context is perfectly defined: the goal, the exact files and APIs it touches, the semantics to
  implement, the constraints, what is out of scope, and what "done" means as checks it can run.
  The lead writes that brief; the agent should need no follow-up questions, and its work is
  judged against the brief's checks, not against a reviewer's taste.
- **Gates verify.** A verdict is evidence; the gate is proof.
- **Humans sit above the lead.** They assign the lead, can override any decision, and keep the
  decisions the project reserves for them (publishing, for example).
- **How each kind of decision is made is configuration.** A project can hand any decision to
  the team — majority, unanimity, veto — or keep it with the lead. The engine hard-codes none
  of it.

## The project definition

```yaml
humans:
  drjones: { can: [assign-lead, override, publish] }

providers:                         # a registry: each vendor once, with its own key and prices
  anthropic: { kind: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
  claude-code: { kind: cli, command: claude }
  openai: { kind: openai-responses, baseUrl: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY }
  xai: { kind: openai-compatible, baseUrl: https://api.x.ai/v1, apiKeyEnv: XAI_API_KEY }
  kimi: { kind: openai-compatible, baseUrl: https://api.moonshot.ai/v1, apiKeyEnv: MOONSHOT_API_KEY }
  glm: { kind: openai-compatible, baseUrl: https://api.z.ai/api/paas/v4, apiKeyEnv: ZAI_API_KEY }   # env name unconfirmed

agents:                            # an agent is a provider, a model and a prompt
  claude-lead: { provider: claude-code, model: opus }
  claude-dev:  { provider: claude-code, model: opus }
  grok:        { provider: xai, model: grok-4.7 }
  kimi:        { provider: kimi, model: kimi-k3 }
  glm:         { provider: glm, model: glm-5.3 }

roles:
  lead: claude-lead                # assigned by a human; any agent, any vendor
  implementers: [claude-dev]
  reviewers: [grok, kimi, glm]

decisions:
  lead-assignment: { mode: human }                     # fixed: always human
  pr-review:       { mode: lead-with-advisors, advisors: reviewers, timeoutMs: 300000, rounds: 1 }
  rfc:             { mode: majority, voters: reviewers, quorum: 2 }
  gate-failure:    { mode: lead }
  merge:           { mode: lead }
  publish:         { mode: human, humans: [drjones] }
```

Endpoints and model ids come from the vendors' documentation as of 2026-09-29; see
[providers](./providers.md), which also records what is unconfirmed.

## Decision modes

| Mode | Who decides | Notes |
|------|-------------|-------|
| `lead` | the lead alone | no other verdicts |
| `lead-with-advisors` | the lead | advisors' verdicts and blockers are given to the lead; they inform, they do not override |
| `majority` | the team | strict majority of cast verdicts; below `quorum`, no decision |
| `unanimous` | the team | every cast verdict approves |
| `veto` | the team | majority and no blocker from anyone — the old committee rule |
| `human` | a named human | the engine waits; `humans` restricts who |

Every policy may set `quorum`, `timeoutMs` (a seat that does not answer in time abstains; it
never blocks) and `rounds` (revision cycles before the decision escalates).

Defaults when `decisions` is absent reproduce the old engine exactly: `pr-review` is `veto`
with quorum 2 and 3 rounds, `rfc` is `majority` with quorum 1. Projects move off them by
configuration.

## Rules the engine enforces

1. **Only humans assign the lead.** `lead-assignment` is always `mode: human`; the validator
   rejects anything else. A change of `roles.lead` is honoured only when it was made by a human
   with `assign-lead` (checked against the commit or request that changed the definition).
2. **The lead's powers are its decisions.** The lead decides exactly the kinds configured as
   `lead` or `lead-with-advisors`, and nothing else.
3. **Humans override anything**, per their `can` list.
4. **Verdicts are structured.** Reviewers answer through a tool with a schema
   (`approve | changes | abstain`, blockers, confidence, summary), not free text.
5. **Nothing waits on the slowest seat.** Seats run in parallel with a timeout; late seats
   abstain.
6. **No work without a complete brief.** The engine refuses to start an agent on a brief with
   no acceptance checks or no stated scope.

## Modules

- **briefs** — a brief is a typed document, not a prompt string: goal, context (files, APIs,
  prior decisions), specification, constraints, out of scope, acceptance checks (commands the
  gate runs) and the expected report. The lead writes it; context-builder resolves its file
  references; the same brief goes to any vendor, and a missing section fails validation before
  an agent is ever started.

- **decisions** — `decide(kind, verdicts, policy)`: pure, no I/O, fully tested.
- **roles** — who holds which role, read from the definition; the lead is a real engine role.
- **providers** — a registry built from `providers:`, one interface to run an agent turn
  whether the vendor is an API, a CLI or an external bridge; prices per model for cost tracking.
- **stages** — task, implement, gate, publish, review, decide, merge: each a replaceable
  module with typed outcomes, instead of one step machine.

## Plan

Each step is one PR with tests, and keeps the old behaviour as the default until the project
definition says otherwise.

1. Clean base: reconcile `main` and `staging` without rewriting history.
2. Decision layer and the `decisions` / `roles` / `humans` blocks (types, loader, validator).
3. Structured verdicts, then the review stage calling `decide`.
4. Roles as data; the lead as an engine role.
5. Provider registry; xAI, Kimi and GLM as reviewers and advisors. As implementers they need an
   agent loop that works on a worktree, or their coding CLIs — a later step.
6. Stages split out of the pipeline.
