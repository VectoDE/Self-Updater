import fs from "fs";
import path from "path";
import { Command } from "commander";
import {
    CONFIG_VERSION,
    getConfigPath,
    getStatePath,
    HooksConfig,
    loadConfig,
    LoggingConfig,
    saveConfig,
    ScheduleConfig,
    ServiceConfig,
    UpdaterConfig,
    WorkspaceConfig,
    validateConfig,
} from "./config";
import { logger } from "./logger";
import { RepositoryWatcher } from "./watcher";
import { UpdateManager } from "./updater";

interface UpdaterState {
    lastCommit?: string;
    updatedAt?: string;
}

function loadEnvironment() {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
        return;
    }

    const content = fs.readFileSync(envPath, "utf-8");
    content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return;
        }

        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) {
            return;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        const value = trimmed.slice(separatorIndex + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    });
}

function loadState(): UpdaterState {
    const statePath = getStatePath();
    if (!fs.existsSync(statePath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(statePath, "utf-8");
        return JSON.parse(raw) as UpdaterState;
    } catch (error) {
        logger.warn("Failed to parse state file", {
            error: error instanceof Error ? error.message : String(error),
        });
        return {};
    }
}

function saveState(state: UpdaterState) {
    const statePath = getStatePath();
    const directory = path.dirname(statePath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function buildWorkspaceConfig(options: any): WorkspaceConfig {
    return {
        localPath: path.resolve(options.path),
        shallowClone: Boolean(options.shallowClone),
        autoInstall: Boolean(options.autoInstall),
        installCommand: options.installCommand,
    };
}

function buildServiceConfig(options: any): ServiceConfig {
    return {
        type: options.type,
        name: options.name,
        restartCommand: options.restartCommand,
        dockerCompose: Boolean(options.dockerCompose),
        dockerComposeService: options.composeService,
        dockerComposeFile: options.composeFile,
    };
}

function buildScheduleConfig(options: any): ScheduleConfig {
    const interval = Number.parseInt(options.interval, 10);
    const jitter = Number.parseInt(options.jitter ?? "0", 10);
    return {
        intervalSeconds: Number.isNaN(interval) ? 60 : interval,
        jitterSeconds: Number.isNaN(jitter) ? 0 : jitter,
    };
}

function buildHooks(options: any): HooksConfig {
    return {
        preUpdate: options.pre,
        postUpdate: options.post,
    };
}

function buildLogging(options: any): LoggingConfig {
    return {
        level: (options.logLevel ?? "info") as LoggingConfig["level"],
        file: options.logFile,
    };
}

async function runUpdateLoop(config: UpdaterConfig, immediate: boolean) {
    const watcher = new RepositoryWatcher(config);
    const manager = new UpdateManager(config);
    const state = loadState();
    let isRunning = false;

    const performCheck = async (trigger: string) => {
        if (isRunning) {
            logger.warn("Previous update cycle still running – skipping", { trigger });
            return;
        }

        isRunning = true;
        try {
            logger.info("Starting update cycle", { trigger });
            const remoteCommit = await watcher.getLatestCommit();
            const result = await manager.updateToCommit(remoteCommit);
            if (result.updated && result.currentCommit) {
                state.lastCommit = result.currentCommit;
                state.updatedAt = new Date().toISOString();
                saveState(state);
            } else if (!state.lastCommit && (result.currentCommit || result.previousCommit)) {
                state.lastCommit = result.currentCommit ?? result.previousCommit;
                saveState(state);
            }
        } catch (error) {
            logger.error("Update cycle failed", error as Error);
        } finally {
            isRunning = false;
        }
    };

    const scheduleNext = () => {
        const interval = config.schedule.intervalSeconds * 1000;
        const jitter = config.schedule.jitterSeconds * 1000;
        const delay = interval + (jitter ? Math.floor(Math.random() * jitter) : 0);
        setTimeout(async () => {
            await performCheck("scheduled");
            scheduleNext();
        }, delay);
    };

    await manager.ensureRepository();
    if (immediate) {
        await performCheck("initial");
    }
    scheduleNext();
    logger.info("Updater started", {
        intervalSeconds: config.schedule.intervalSeconds,
        jitterSeconds: config.schedule.jitterSeconds,
        configPath: getConfigPath(),
    });
}

async function runSingleUpdate(config: UpdaterConfig) {
    const watcher = new RepositoryWatcher(config);
    const manager = new UpdateManager(config);
    await manager.ensureRepository();
    const remoteCommit = await watcher.getLatestCommit();
    const result = await manager.updateToCommit(remoteCommit);
    const state: UpdaterState = {};
    state.lastCommit = result.currentCommit ?? result.previousCommit ?? undefined;
    if (result.updated && result.currentCommit) {
        state.updatedAt = new Date().toISOString();
    }
    if (state.lastCommit) {
        saveState(state);
    }
}

async function showStatus(config: UpdaterConfig) {
    const watcher = new RepositoryWatcher(config);
    const manager = new UpdateManager(config);
    await manager.ensureRepository();
    const current = await manager.getCurrentCommit();
    const remote = await watcher.getLatestCommit();

    const status = current === remote ? "✅ Up to date" : "⚠️ Update available";
    console.log(status);
    console.log(`Local commit:  ${current ?? "unknown"}`);
    console.log(`Remote commit: ${remote}`);

    const state = loadState();
    if (state.updatedAt) {
        console.log(`Last update: ${state.updatedAt}`);
    }
}

loadEnvironment();

const program = new Command();
program.name("self-updater").description("Enterprise-grade self-updating service manager");

program
    .command("init")
    .description("Initialize configuration")
    .requiredOption("-r, --repo <url>", "Git repository URL")
    .option("-b, --branch <branch>", "Branch", "main")
    .requiredOption("-p, --path <path>", "Local path of the project")
    .option("--remote <remote>", "Git remote name", "origin")
    .requiredOption("-t, --type <pm2|docker|command>", "Service type")
    .option("-n, --name <service>", "Service name")
    .option("-i, --interval <seconds>", "Check interval in seconds", "60")
    .option("-j, --jitter <seconds>", "Random jitter in seconds", "0")
    .option("--token <token>", "Authentication token for Git provider APIs")
    .option("--pre <command>", "Command executed before updating")
    .option("--post <command>", "Command executed after restarting")
    .option("--auto-install", "Automatically run install command when dependencies change")
    .option("--install-command <command>", "Command used to install dependencies", "npm install")
    .option("--shallow-clone", "Clone the repository with depth=1")
    .option("--docker-compose", "Use docker compose instead of docker restart")
    .option("--compose-service <service>", "Docker compose service name")
    .option("--compose-file <file>", "Docker compose file path")
    .option("--restart-command <command>", "Custom restart command")
    .option("--log-level <level>", "Log level (error|warn|info|debug)", "info")
    .option("--log-file <file>", "Optional log file path")
    .action((options) => {
        const workspace = buildWorkspaceConfig(options);
        const service = buildServiceConfig(options);
        const schedule = buildScheduleConfig(options);
        const hooks = buildHooks(options);
        const logging = buildLogging(options);

        const config: UpdaterConfig = validateConfig({
            version: CONFIG_VERSION,
            repo: {
                url: options.repo,
                branch: options.branch,
                remote: options.remote,
                authToken: options.token,
            },
            workspace,
            service,
            schedule,
            hooks,
            logging,
        });

        saveConfig(config);
        console.log(`✅ Configuration saved at ${getConfigPath()}`);
    });

program
    .command("start")
    .description("Start the updater loop")
    .option("--immediate", "Run an update check immediately on startup")
    .action(async (options) => {
        try {
            const config = loadConfig();
            await runUpdateLoop(config, Boolean(options.immediate));
        } catch (error) {
            logger.error("Unable to start updater", error as Error);
            process.exitCode = 1;
        }
    });

program
    .command("run-once")
    .description("Run a single update cycle and exit")
    .action(async () => {
        try {
            const config = loadConfig();
            await runSingleUpdate(config);
        } catch (error) {
            logger.error("Update failed", error as Error);
            process.exitCode = 1;
        }
    });

program
    .command("status")
    .description("Show repository synchronization status")
    .action(async () => {
        try {
            const config = loadConfig();
            await showStatus(config);
        } catch (error) {
            logger.error("Unable to load status", error as Error);
            process.exitCode = 1;
        }
    });

program
    .command("validate")
    .description("Validate the current configuration")
    .action(() => {
        try {
            const config = loadConfig();
            validateConfig(config);
            console.log("✅ Configuration is valid");
        } catch (error) {
            logger.error("Configuration validation failed", error as Error);
            process.exitCode = 1;
        }
    });

program.parse(process.argv);
