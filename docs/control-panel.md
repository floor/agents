# The Control Panel

A page to see what the engines are doing: each project's to-do list with the status of every
issue, the runs that were recorded, and the team. It reads; it does not act yet.

```
 browser ──▶ Floor IO  :3400   /agents, /agents/<project>
                │
                │  /agents/api/<project>/…   (pass-through, same origin)
                ▼
        engine of vlist :3111      engine of mtrl :3112      engine of agents :3113
        floor-agents serve|watch   — the project API, docs/api.md —
                │
                ├── the project's manifest          the team
                ├── the task source (Linear)        the open issues
                └── the state directory             the recorded runs
```

Two parts, in two repositories:

- **The engine side**, here: every engine process serves the read-only [Project API](./api.md)
  for its one project. That page is the contract.
- **The panel**, in Floor IO (`floor/floor.io`): `src/server/agents.ts` and
  `src/templates/agents.html`. It holds no knowledge of runs or issues. It forwards the browser's
  questions to the right engine and draws the answers. Any other panel can be written against the
  same API.

## Running it locally

```sh
# 1. One API process per project (from floor/agents). They take no task and start no agent.
pm2 start ecosystem.config.cjs --only agents-api-vlist,agents-api-mtrl,agents-api-agents

# 2. Floor IO, on its default port.
cd ../floor.io && bun run start          # http://localhost:3400

# 3. Open http://localhost:3400/agents
```

When a project's **watcher** runs (`agents-vlist`, `agents-mtrl`), it serves the same API on the
same port: stop that project's `agents-api-…` process first, and the panel shows it as
`watching` instead of `serving only`.

| Port | |
|------|---|
| 3400 | Floor IO. Not 3100: that is the engine gateway's default, and a review that finds it taken loses its external seats |
| 3111, 3112, 3113 | The project APIs of vlist, mtrl, agents (`API_PORT`) |
| 3101, 3102 | The watchers' gateways (`GATEWAY_PORT`) |
| 47601… | [Machine slots](./cli.md#machine-slots) |

Floor IO learns the projects from `AGENTS_PROJECTS` — `name=url` pairs, comma-separated. The
default is the three above. `AGENTS_API_TOKEN` is sent as a bearer token when the engines were
started with `API_TOKEN`.

## What it shows

**`/agents`** — one card per project: whether its engine answers and in which mode, the open
issues, how many are queued for the agents, how many runs are under way, and how many wait for a
person. A project whose engine is not running says so, with the command that starts it.

**`/agents/<project>`**

- **The team**: each agent's role, model, and whether it connects through a bridge.
- **To do**: every open issue of the task source — not only the agents' queue — with its status,
  milestone, and its run when it has one. Runs under way come first, then what waits for a person,
  then the queue. Filters: all, running, needs a person, queued, has a run.
- **A run, opened**: click an issue that has a run. Every attempt (agent, model, turn time, the
  gate and each of its checks, the end of what a failing check printed, what the agent said it
  did, where a kept tree is) and every review cycle (each member's vote, a seat that did not
  review, the blockers, a blocker that stood through a revision), in the order they happened.
- **Earlier runs**: runs whose issue is closed now.

The page asks again every ten seconds while it is visible. The engines ask the task source at
most once every fifteen seconds, whatever the page does.

| The pill | Means |
|----------|-------|
| working, at the gate, in review, revising | A run is under way, and where |
| done | Published and, when a committee reviews, approved |
| needs a person | No decision, a blocker that stood through a revision, or the maximum of review cycles |
| failed | The run stopped on an error: a guardrail, a gate, a push |

## Where it must not be served

Floor IO is also the public company site. The panel is mounted **in development only**:
`routeAgents` returns nothing when `NODE_ENV=production`, exactly like `/docs`, so the deployed
site cannot serve it even by accident. The engines listen on the loopback interface only, and the
panel's pass-through accepts `GET` and the API's own paths, nothing else. The page sets every
string it receives as text, never as markup: an issue title is not trusted.

## What comes next

1. **Actions**, through a version of the API that writes: start a task (the label, or `run`),
   seat a review again (`review`), stop a run. Each is one command today.
2. **The team**: adding a member is a change to the project's manifest, which lives in git. The
   panel will open a pull request, not write the file.
3. **Live updates** instead of polling, once the engines run as watchers.
4. **History across days**: how long issues take, where runs stop, per project and per agent.
