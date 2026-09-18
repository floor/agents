# The Project API

What an engine process tells a control panel: the project it serves, its team, its open issues
and the runs it has recorded. Read-only, JSON, versioned, local.

One engine process serves **one project** — one manifest, one task source, one repository. A panel
that shows several projects asks each project's process. The reference panel is Floor IO's
`/agents` (see [The Control Panel](./control-panel.md)).

- Package: `@floor-agents/api` (`packages/api/`). The response types in `src/types.ts` are the
  contract; the engine's own records may change shape without the API doing so.
- Served by `floor-agents serve` (the API and nothing else) and by `floor-agents watch` (beside
  its watchers).
- Listens on **127.0.0.1 only**. The answers name branches, worktrees and the ends of failing
  test runs; they are not for a network.

## Starting it

```sh
# The API alone: takes no task, starts no agent.
API_PORT=3112 floor-agents serve --config ../mtrl/.agents/agents.yaml

# Under pm2, with the shipped ecosystem file:
pm2 start ecosystem.config.cjs --only agents-api-vlist,agents-api-mtrl,agents-api-agents
```

| Variable | Default | |
|----------|---------|---|
| `API_PORT` | `3110` | The port. The shipped pm2 file uses 3111 (vlist), 3112 (mtrl), 3113 (agents) |
| `API_TOKEN` | — | When set, every request must carry `Authorization: Bearer <token>` |
| `STATE_DIR` | `runs/` beside the manifest | Where the recorded runs are read from |

A project's watcher and its `serve` process use the same port: run one or the other. `serve`
skips the project preflight — it runs none of the project's commands.

**Several projects, one state directory.** Runs started by hand from one folder may all be written
to that folder's state directory. Each API lists only its own project's runs: a run names its
repository (`repo`, since this API); an older record is recognised by its pull request's URL, or
by belonging to an issue the project lists.

**Which Linear project.** The one the manifest names (`tasks.linear.project`). `LINEAR_PROJECT_ID`
in the environment is only the fallback for a manifest that names none — it used to win, and an
engine started from another project's folder read that project's issues.

## Conventions

- Base path `/api/v1`. A breaking change gets a new version; additions do not.
- `GET` and `HEAD` only. Anything else: `405 {"error": "the project API is read-only"}`.
- Every answer is JSON with `Cache-Control: no-store`. Errors are `{"error": "<what went wrong>"}`
  with `401`, `404`, `405` or `500`.
- Dates are ISO 8601 strings. Durations are milliseconds (`…Ms`). A value that does not exist is
  `null`, never absent.
- The task source is asked at most once every 15 seconds, whatever the panel's polling rate.

## Endpoints

### `GET /api/v1/health`

```json
{ "ok": true, "project": "mtrl", "mode": "serve" }
```

### `GET /api/v1/project`

The project, the engine process answering, and the team.

```json
{
  "name": "mtrl",
  "repo": "floor/mtrl",
  "baseBranch": "main",
  "taskSource": "linear",
  "triggerLabels": ["agent"],
  "engine": { "version": "0.1.0", "mode": "serve", "pid": 4242, "startedAt": "2026-09-18T21:40:00.000Z", "api": "v1" },
  "limits": { "maxRuns": 2, "maxReviewCycles": 3 },
  "team": [
    { "id": "grok-dev", "name": "Grok", "role": "implementer", "provider": "cursor", "model": "cursor-grok-4.6-high", "external": false, "capabilities": ["read_code", "write_code"] },
    { "id": "codex", "name": "Codex", "role": "committee member", "provider": "codex-cli", "model": "local", "external": true, "capabilities": ["review_rfc", "vote"] }
  ]
}
```

| Field | |
|-------|---|
| `engine.mode` | `serve` — only answering; `watch` — also taking issues from the task source |
| `limits.maxRuns` | Tasks at once on the machine, across engine processes ([machine slots](./cli.md#machine-slots)); `0` is no limit |
| `team[].role` | Read from the capabilities: `write_code` → `implementer`; `vote` → `committee member`; `review_pr` or `review_rfc` → `reviewer`; `decompose` or `plan` → `planner`; else `member` |
| `team[].external` | It connects through the gateway (a CLI bridge) rather than being dispatched by the engine |

### `GET /api/v1/issues`

The project's to-do list: **every open issue of the task source, whatever its labels**, each with
its recorded run when it has one. Not the agents' queue — `queued` says which issues carry a
trigger label.

```json
{
  "generatedAt": "2026-09-18T21:41:07.000Z",
  "source": "task-source",
  "sourceError": null,
  "issues": [
    {
      "id": "30867a0c-ea83-4b13-9c20-7793db11a128",
      "key": "FLO-96",
      "title": "[N10] `check()` on an indeterminate checkbox leaves it indeterminate",
      "status": "in_progress",
      "stateName": "In Review",
      "milestone": "0.9.8",
      "priority": 3,
      "labels": ["agent"],
      "url": "https://linear.app/…/FLO-96",
      "queued": true,
      "updatedAt": "2026-09-18T21:12:30.000Z",
      "run": { "…": "a run summary, see below" }
    }
  ]
}
```

| Field | |
|-------|---|
| `source` | `task-source` — the list came from it. `runs` — it could not be asked (down, or an adapter that cannot list); only issues that have a run are listed, and `sourceError` says why. A task source that is down does not take the panel down |
| `status` | The engine's reading: `backlog`, `triage`, `in_progress`, `in_review`, `qa`, `done`, `changes_requested`; `unknown` for an issue rebuilt from its run |
| `stateName` | The task source's own word for it ("In Review") |
| `priority` | 1 urgent … 4 low; `null` when none |
| `run` | The issue's run summary, or `null` |

A run in progress whose issue the task source no longer lists (closed by hand) is still listed,
rebuilt from what the run recorded. Requires the task adapter to implement `listOpenIssues()`
(Linear does).

### `GET /api/v1/runs`

Every recorded run of the project, newest first — including those of issues that are closed.

```json
{ "generatedAt": "…", "runs": [ { "…": "run summaries" } ] }
```

**A run summary:**

```json
{
  "issueId": "30867a0c-…",
  "issueKey": "FLO-96",
  "issueTitle": "[N10] `check()` on an indeterminate checkbox leaves it indeterminate",
  "step": "done",
  "phase": "done",
  "error": null,
  "agentId": "grok-dev",
  "branch": "agent/30867a0c-n10-…",
  "prUrl": "https://github.com/floor/mtrl/pull/93",
  "attempts": 1,
  "lastAttempt": { "n": 1, "kind": "implement", "agentId": "grok-dev", "model": "cursor-grok-4.6-high", "outcome": "published", "turnMs": 222000, "gate": "passed", "gateMs": 110000, "continues": null, "commit": "83e6820a", "startedAt": "…", "endedAt": "…" },
  "reviews": 1,
  "lastReview": { "cycle": 1, "outcome": "approve", "durationMs": 94000, "at": "…", "votes": [ { "agent": "Claude", "vote": "approve", "failed": false }, { "agent": "Codex", "vote": "approve", "failed": false } ] },
  "costUsd": 1.48,
  "workMs": 426000,
  "startedAt": "…",
  "updatedAt": "…"
}
```

| Field | |
|-------|---|
| `step` | The engine's precise cursor (`calling_llm`, `reviewing`, `done`, `failed`, …) |
| `phase` | What a person wants at a glance: `working`, `verifying` (the turn ended, its tree is at the gate), `reviewing`, `revising`, `done`, `failed`, and **`needs-person`** — a review that ended with no decision, a blocker that stood through a revision, or the maximum of review cycles |
| `error` | The first line of the error, for a run that stopped |
| `lastAttempt.outcome` | `running`, `published`, `stopped`, `no-changes`, `guardrail`, `gate-failed`, `error` |
| `lastAttempt.continues` | The attempt whose CLI session this revision resumed |
| `lastReview.votes[].failed` | The seat never answered (quota, crash, bridge): not a member abstaining |
| `workMs` | Turns, gates and reviews added up: the engine's working time, not the wall clock |
| `issueKey`, `issueTitle` | `null` on runs recorded before the API existed |

### `GET /api/v1/runs/:issue`

One run in full, by issue key (`FLO-96`, any case) or id. `404` when none is recorded. The summary
above, plus:

```json
{
  "attemptList": [
    {
      "n": 1, "kind": "implement", "outcome": "published", "turnMs": 222000, "gate": "passed", "…": "…",
      "reply": "What the agent said it did, shortened",
      "error": null,
      "worktreePath": null,
      "gates": [
        { "at": "…", "passed": true, "durationMs": 110000, "error": null,
          "checks": [ { "name": "Tests", "passed": true, "timedOut": false, "durationMs": 60000, "tail": null } ] }
      ]
    }
  ],
  "reviewList": [
    { "cycle": 1, "outcome": "approve", "durationMs": 94000, "at": "…", "votes": ["…"], "commit": "83e6820a", "blockers": null, "standing": [] }
  ]
}
```

| Field | |
|-------|---|
| `attemptList[].worktreePath` | Where the tree was kept, for an attempt that was not published |
| `gates[].checks[].tail` | The end of what a failing check printed; `null` for a check that passed |
| `reviewList[].blockers` | The blockers handed to the implementer, as one text |
| `reviewList[].standing` | Blockers a member repeated after a revision: why the loop stopped for a person |

The agent's full output and any parsed files are never part of an answer.

## What it does not do yet

Nothing is written through the API: starting a task, seating a review again and changing the team
are still commands (`run`, `review`) and manifest changes. They are the next version's subject,
and changing the team will go through a pull request on the manifest, not a write to the file.
There is no push channel either: a panel polls.
