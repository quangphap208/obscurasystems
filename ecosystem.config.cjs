// pm2 — chạy FE (bot) và BE (engine) như 2 process riêng, tự restart. `pm2 start ecosystem.config.cjs`.
module.exports = {
  apps: [
    {
      name: "kol-fe",
      script: "fe/bot.mjs",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: { NODE_ENV: "production" },
    },
    {
      name: "kol-be",
      script: "be/engine.mjs",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: { NODE_ENV: "production" },
    },
  ],
};
