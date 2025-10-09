import simpleGit from "simple-git";
import { exec } from "child_process";
import { UpdaterConfig } from "./config";

export async function updateAndRestart(config: UpdaterConfig) {
    const git = simpleGit(config.localPath);
    await git.pull("origin", config.branch);

    if (config.serviceType === "pm2") {
        exec(`pm2 restart ${config.serviceName}`, (err, stdout, stderr) => {
            if (err) console.error("PM2 restart error:", stderr);
            else console.log("PM2 restarted:", stdout);
        });
    }

    if (config.serviceType === "docker") {
        exec(`docker restart ${config.serviceName}`, (err, stdout, stderr) => {
            if (err) console.error("Docker restart error:", stderr);
            else console.log("Docker restarted:", stdout);
        });
    }
}
