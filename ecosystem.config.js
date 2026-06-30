module.exports = {
  apps: [{
    name: "tradesnow-app",
    script: "/root/tradesnow/dist/index.js",
    cwd: "/root/tradesnow",
    interpreter: "node",
    env: {
      NODE_ENV: "production"
    },
    env_file: "/root/tradesnow/.env"
  }]
};