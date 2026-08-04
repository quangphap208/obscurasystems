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
    {
      // BE thứ 2 (nguồn j7). Chạy song song kol-be; dedup chéo qua Mongo `deliveries`.
      // Chỉ bật khi đã cấu hình J7_SESSION_TOKEN. Tắt: pm2 stop kol-be-j7.
      name: "kol-be-j7",
      script: "be-j7/engine-j7.mjs",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      env: { NODE_ENV: "production" },
    },
  ],
};
