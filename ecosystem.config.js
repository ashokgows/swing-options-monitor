/**
 * PM2 process config for Swing Options Bot
 * Usage: pm2 start ecosystem.config.js
 */
module.exports = {
  apps: [
    {
      name:        "swing-options-bot",
      script:      "swing-options-bot.js",
      node_args:   "--env-file=.env.production",
      cwd:         "/home/ubuntu/swing-options-monitor",
      instances:   1,
      autorestart: true,
      watch:       false,
      max_restarts: 10,
      restart_delay: 5000,      // wait 5 s before each restart
      max_memory_restart: "400M",

      // Environment — loaded from .env.production via node_args above.
      // These are fallback defaults only; do NOT store real credentials here.
      env: {
        NODE_ENV: "production",
      },

      // Log rotation (requires pm2-logrotate module)
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file:      "/home/ubuntu/swing-options-monitor/logs/error.log",
      out_file:        "/home/ubuntu/swing-options-monitor/logs/out.log",
      merge_logs:      true,
    },
  ],
};
