const { resolve } = require('path')

const configPath = process.env.CONFIG_PATH || './config/templates/default.yaml'

module.exports = {
  apps: [
    {
      name: `floor-agents`,
      script: 'src/main.ts',
      interpreter: 'bun',
      cwd: __dirname,
      env: {
        CONFIG_PATH: resolve(configPath),
      },
      max_restarts: 10,
      min_uptime: 5000,
      restart_delay: 3000,
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
