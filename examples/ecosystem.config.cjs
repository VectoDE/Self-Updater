// PM2 process file for the updater itself: pm2 start examples/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'self-updater',
      script: 'self-updater',
      args: 'start --immediate',
      interpreter: 'none',
      cwd: '/etc/self-updater',
      env: { SELF_UPDATER_CONFIG: '/etc/self-updater/updater.config.json' },
      autorestart: true,
      // A running deployment gets time to finish before PM2 kills the process.
      kill_timeout: 15 * 60 * 1000,
      max_restarts: 10,
      min_uptime: '30s',
      time: true,
    },
  ],
};
