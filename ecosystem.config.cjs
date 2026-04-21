module.exports = {
  apps: [
    {
      name: "copilot-relay",
      script: "bin/relay.ts",
      args: "serve",
      interpreter: "bun",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
