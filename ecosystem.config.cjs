module.exports = {
    apps: [
        {
            name: "self-updater",
            script: "./bin/cli.js",
            args: "start --immediate",
            cwd: __dirname,
            env: {
                NODE_ENV: "production",
            },
            autorestart: true,
            watch: false,
            max_restarts: 10,
            min_uptime: "30s",
            time: true,
            out_file: "./logs/out.log",
            error_file: "./logs/error.log",
            merge_logs: true,
        },
    ],
};
