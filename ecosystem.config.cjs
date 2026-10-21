// pm2 phải start từ terminal BÊN TRONG cmux: socket cmux chỉ nhận caller mang
// CMUX_SOCKET_CAPABILITY (cmux cấp theo workspace), pm2 truyền tiếp cho process con.
// Restart cmux / reboot → token chết → `pm2 restart onelark --update-env` từ terminal cmux.
module.exports = {
  apps: [
    {
      name: 'onelark',
      script: 'src/daemon.ts',
      cwd: __dirname,
      interpreter: 'node',
      node_args: ['--disable-warning=ExperimentalWarning'],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 5000,
      merge_logs: true,
      out_file: `${process.env.HOME}/.pm2/logs/onelark-out.log`,
      error_file: `${process.env.HOME}/.pm2/logs/onelark-error.log`,
    },
  ],
};
