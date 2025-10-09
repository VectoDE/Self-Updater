import { Command } from "commander";
import { loadConfig, saveConfig, UpdaterConfig } from "./config";
import { getLatestCommit } from "./watcher";
import { updateAndRestart } from "./updater";

const program = new Command();

program
    .command("init")
    .description("Initialize configuration")
    .requiredOption("-r, --repo <url>", "GitHub/GitLab Repository URL")
    .option("-b, --branch <branch>", "Branch", "main")
    .requiredOption("-p, --path <path>", "Local path of the project")
    .requiredOption("-t, --type <pm2|docker>", "Service Typ")
    .requiredOption("-n, --name <service>", "Service Name")
    .option("-i, --interval <seconds>", "Check-Intervall", "60")
    .action((options) => {
        const config: UpdaterConfig = {
            repoUrl: options.repo,
            branch: options.branch,
            localPath: options.path,
            serviceType: options.type,
            serviceName: options.name,
            checkInterval: parseInt(options.interval, 10),
        };
        saveConfig(config);
        console.log("✅ Configuration saved!");
    });

program
    .command("start")
    .description("Start the updater")
    .action(async () => {
        const config = loadConfig();
        let lastCommit = await getLatestCommit(config.repoUrl, config.branch);

        console.log(`🔍 Watching ${config.repoUrl} [${config.branch}]...`);

        setInterval(async () => {
            try {
                const latest = await getLatestCommit(config.repoUrl, config.branch);
                if (latest !== lastCommit) {
                    console.log("📥 New commit found → Update and Restart!");
                    await updateAndRestart(config);
                    lastCommit = latest;
                }
            } catch (e) {
                console.error("Error during check:", e);
            }
        }, config.checkInterval * 1000);
    });

program.parse(process.argv);
