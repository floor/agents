// pm2 processes for the engine: one watcher per project, as Dr Jones asked on
// 2026-09-18 ("we should run 2 different process one for the vlist and one for
// mtrl"). Each watches its own manifest, keeps its own run state beside that
// manifest (a shared state directory would make one watcher resume the other's
// tasks), and opens its own gateway port for its external voters.
//
// The projects are sibling checkouts of this repository, so the paths are
// relative to this file. Start with `pm2 start ecosystem.config.cjs --only
// agents-vlist,agents-mtrl`; the engine repository itself stays on manual
// `run --issue`, its queue being sequential by nature.

const { resolve } = require('path')

const configPath = process.env.CONFIG_PATH || './config/templates/default.yaml'

const common = {
  script: 'src/main.ts',
  interpreter: 'bun',
  cwd: __dirname,
  max_restarts: 10,
  min_uptime: 5000,
  restart_delay: 3000,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
}

/** A watcher for one sibling project: `../<project>/.agents/agents.yaml`. */
const watcher = (project, gatewayPort) => ({
  ...common,
  name: `agents-${project}`,
  args: ['watch', '--config', resolve(__dirname, '..', project, '.agents', 'agents.yaml')],
  env: {
    STATE_DIR: resolve(__dirname, '..', project, '.agents', 'runs'),
    GATEWAY_PORT: String(gatewayPort),
  },
  error_file: `logs/${project}.error.log`,
  out_file: `logs/${project}.out.log`,
})

module.exports = {
  apps: [
    {
      ...common,
      name: 'floor-agents',
      env: { CONFIG_PATH: resolve(configPath) },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
    },
    watcher('vlist', 3101),
    watcher('mtrl', 3102),
  ],
}
