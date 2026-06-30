module.exports = {
  apps: [{
    name: "tradesnow-app",
    script: "/root/tradesnow/dist/index.js",
    cwd: "/root/tradesnow",
    interpreter: "node",
    node_args: "--max-old-space-size=512",
    max_memory_restart: "600M",
    min_uptime: "30s",
    max_restarts: 20,
    restart_delay: 3000,
    env: { NODE_ENV: "production" },
    env_file: "/root/tradesnow/.env"
  }]
};
