/** PM2 生产进程配置：替代 Docker，改完后 npm run build && pm2 reload libretv */
module.exports = {
  apps: [
    {
      name: 'libretv',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 8899',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '8899',
        HOSTNAME: '0.0.0.0',
      },
      max_memory_restart: '512M',
      time: true,
    },
  ],
};
