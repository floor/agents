// PM2 ecosystem entry for the review-and-gate loop (src/gate.ts), for
// running it as a supervised long-running process during a dry-run soak or
// beyond. See docs/dry-run-soak.md for the full runbook — prerequisites,
// the .env.gate shape, how to read the logs, and the exact conditions for
// flipping merging on.
//
// This file intentionally carries NO target-specific values (no repo name,
// no token, no merge-enabled flag) — everything environment-specific lives
// in the gitignored .env.gate and a gitignored config/gate/local.*.yaml,
// loaded at process start via --env-file. This file is never started
// automatically by any agent; a human (or an operator explicitly running
// the soak) runs `pm2 start ecosystem.gate.config.cjs` by hand once those
// two local files exist and are filled in.

module.exports = {
  apps: [
    {
      name: 'floor-agents-gate-dryrun',
      script: 'src/gate.ts',
      interpreter: 'bun',
      // Loads .env.gate (gitignored) without ever putting real values in
      // this tracked file. Requires a Bun version with `--env-file`
      // support (bun --version; 1.1+).
      interpreter_args: '--env-file=.env.gate',
      cwd: __dirname,

      // A single stateful poller with no inbound traffic to load-balance —
      // a second cluster worker would only double-poll the same PRs and
      // duplicate every review and log line. Fork + one instance is
      // correct here, not a limitation to fix later.
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',

      // The loop persists its own decision state (GateModeConfig.stateDir,
      // default ./data/gate) on every single pass. If PM2 were watching
      // the working directory for changes, every state-file write would
      // look like a reason to restart the process — forever. Always false.
      watch: false,

      out_file: './data/logs/gate-dryrun-out.log',
      error_file: './data/logs/gate-dryrun-error.log',
      time: true,

      // Pinned here, in the tracked ecosystem file, rather than left to
      // .env.gate or ambient shell/daemon environment: PM2 forwards its own
      // process environment into a forked app before .env.gate is loaded,
      // and Bun's --env-file does not override a variable that's already
      // set — so an unrelated GATE_MERGE_ENABLED=true left over in the
      // PM2 daemon's own environment (e.g. from testing something else in
      // the same shell) would silently enable real merges even though
      // .env.gate never sets it and the config file defaults to false.
      // Explicitly setting it to 'false' here means the only way to flip
      // it on is to edit THIS value — a visible, deliberate, reviewable
      // change to a tracked file — not a gitignored env file or ambient
      // shell state. See "When to flip GATE_MERGE_ENABLED on" in
      // docs/dry-run-soak.md before ever changing this to 'true'.
      env: {
        GATE_MERGE_ENABLED: 'false',
      },
    },
  ],
}
