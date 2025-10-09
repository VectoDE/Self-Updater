import fs from "fs";
import path from "path";

export interface UpdaterConfig {
    repoUrl: string;
    branch: string;
    localPath: string;
    serviceType: "pm2" | "docker";
    serviceName: string;
    checkInterval: number; // seconds
}

const CONFIG_PATH = path.resolve(process.cwd(), "updater.config.json");

export function loadConfig(): UpdaterConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error("No configuration found. Please set it up first!");
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveConfig(config: UpdaterConfig) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
