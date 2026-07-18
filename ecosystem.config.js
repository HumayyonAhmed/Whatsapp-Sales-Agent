// PM2 process manager config — alternative to Docker for a plain VPS.
// Usage: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "whatsapp-sales-agent",
      script: "src/server.js",
      instances: 1, // keep at 1 unless you move session storage to Redis/Postgres
      autorestart: true,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};
