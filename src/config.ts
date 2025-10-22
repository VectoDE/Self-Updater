import fs from "fs";
import path from "path";
import { logger, LogLevel, setLoggerOptions } from "./logger";

export type ServiceType = "pm2" | "docker" | "command";

export interface RepoConfig {
    url: string;
    branch: string;
    remote: string;
    authToken?: string;
}

export interface WorkspaceConfig {
    localPath: string;
    shallowClone?: boolean;
    autoInstall?: boolean;
    installCommand?: string;
}

export interface ServiceConfig {
    type: ServiceType;
    name?: string;
    restartCommand?: string;
    dockerCompose?: boolean;
    dockerComposeService?: string;
    dockerComposeFile?: string;
}

export interface ScheduleConfig {
    intervalSeconds: number;
    jitterSeconds: number;
}

export interface HooksConfig {
    preUpdate?: string;
    postUpdate?: string;
}

export interface LoggingConfig {
    level: LogLevel;
    file?: string;
}

export interface UpdaterConfig {
    version: typeof CONFIG_VERSION;
    repo: RepoConfig;
    workspace: WorkspaceConfig;
    service: ServiceConfig;
    schedule: ScheduleConfig;
    hooks: HooksConfig;
    logging: LoggingConfig;
}

export interface LegacyUpdaterConfig {
    repoUrl: string;
    branch?: string;
    localPath: string;
    serviceType: ServiceType;
    serviceName: string;
    checkInterval?: number;
    authToken?: string;
    preUpdateCommand?: string;
    postUpdateCommand?: string;
    autoInstall?: boolean;
    installCommand?: string;
    shallowClone?: boolean;
    dockerCompose?: boolean;
    dockerComposeService?: string;
    dockerComposeFile?: string;
    restartCommand?: string;
    jitterSeconds?: number;
    logLevel?: LogLevel;
    logFile?: string;
}

export const CONFIG_VERSION = 2 as const;

const DEFAULT_CONFIG: UpdaterConfig = {
    version: CONFIG_VERSION,
    repo: {
        url: "",
        branch: "main",
        remote: "origin",
    },
    workspace: {
        localPath: "",
        shallowClone: false,
        autoInstall: false,
        installCommand: "npm install",
    },
    service: {
        type: "pm2",
        name: "",
        dockerCompose: false,
    },
    schedule: {
        intervalSeconds: 60,
        jitterSeconds: 0,
    },
    hooks: {},
    logging: {
        level: "info",
    },
};

function resolveConfigPath() {
    return process.env.SELF_UPDATER_CONFIG
        ? path.resolve(process.env.SELF_UPDATER_CONFIG)
        : path.resolve(process.cwd(), "updater.config.json");
}

export function getConfigPath() {
    return resolveConfigPath();
}

export function getStatePath() {
    const configPath = resolveConfigPath();
    const dir = path.dirname(configPath);
    return path.resolve(dir, "updater.state.json");
}

function deepMerge<T>(target: T, source: Partial<T>): T {
    const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };

    Object.entries(source).forEach(([key, value]) => {
        if (value === undefined) {
            return;
        }

        if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            typeof (target as Record<string, unknown>)[key] === "object" &&
            (target as Record<string, unknown>)[key] !== null
        ) {
            result[key] = deepMerge(
                (target as Record<string, unknown>)[key] as Record<string, unknown>,
                value as Record<string, unknown>,
            );
        } else {
            result[key] = value;
        }
    });

    return result as T;
}

function migrateLegacyConfig(legacy: LegacyUpdaterConfig): UpdaterConfig {
    const merged = deepMerge(DEFAULT_CONFIG, {
        repo: {
            url: legacy.repoUrl,
            branch: legacy.branch ?? DEFAULT_CONFIG.repo.branch,
            remote: DEFAULT_CONFIG.repo.remote,
            authToken: legacy.authToken,
        },
        workspace: {
            localPath: legacy.localPath,
            autoInstall: legacy.autoInstall,
            installCommand: legacy.installCommand,
            shallowClone: legacy.shallowClone,
        },
        service: {
            type: legacy.serviceType,
            name: legacy.serviceName,
            dockerCompose: legacy.dockerCompose,
            dockerComposeService: legacy.dockerComposeService,
            dockerComposeFile: legacy.dockerComposeFile,
            restartCommand: legacy.restartCommand,
        },
        schedule: {
            intervalSeconds: legacy.checkInterval ?? DEFAULT_CONFIG.schedule.intervalSeconds,
            jitterSeconds: legacy.jitterSeconds ?? DEFAULT_CONFIG.schedule.jitterSeconds,
        },
        hooks: {
            preUpdate: legacy.preUpdateCommand,
            postUpdate: legacy.postUpdateCommand,
        },
        logging: {
            level: legacy.logLevel ?? DEFAULT_CONFIG.logging.level,
            file: legacy.logFile,
        },
    });

    return validateConfig(merged);
}

function ensureAbsolutePath(filePath: string) {
    return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function parseConfig(raw: unknown): UpdaterConfig {
    if (!raw || typeof raw !== "object") {
        throw new Error("Configuration file is invalid or empty");
    }

    const candidate = raw as Partial<UpdaterConfig> & { version?: number };

    if (!candidate.version || candidate.version !== CONFIG_VERSION) {
        return migrateLegacyConfig(raw as LegacyUpdaterConfig);
    }

    const merged = deepMerge(DEFAULT_CONFIG, candidate);
    return validateConfig(merged);
}

export function loadConfig(): UpdaterConfig {
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
        throw new Error("No configuration found. Please run the init command first.");
    }

    const fileContent = fs.readFileSync(configPath, "utf-8");
    const data = JSON.parse(fileContent);
    const config = parseConfig(data);

    config.workspace.localPath = ensureAbsolutePath(config.workspace.localPath);
    if (config.logging.file) {
        config.logging.file = ensureAbsolutePath(config.logging.file);
    }

    const levelOverride = process.env.SELF_UPDATER_LOG_LEVEL as LogLevel | undefined;
    if (levelOverride && ["error", "warn", "info", "debug"].includes(levelOverride)) {
        config.logging.level = levelOverride;
    }

    setLoggerOptions(config.logging);
    return config;
}

export function saveConfig(config: UpdaterConfig) {
    const normalized = validateConfig(deepMerge(DEFAULT_CONFIG, config));
    const configPath = resolveConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2), "utf-8");
    logger.info("Configuration saved", { path: configPath });
}

function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

export function validateConfig(config: UpdaterConfig): UpdaterConfig {
    assert(Boolean(config.repo.url), "Repository URL is required");
    assert(Boolean(config.repo.branch), "Repository branch is required");
    assert(Boolean(config.workspace.localPath), "Local path is required");

    if (config.service.type === "pm2" || config.service.type === "docker") {
        assert(Boolean(config.service.name), "Service name is required for PM2 and Docker services");
    }

    if (config.service.type === "command") {
        assert(Boolean(config.service.restartCommand), "A restart command is required for command services");
    }

    assert(config.schedule.intervalSeconds >= 15, "Interval must be at least 15 seconds");
    assert(config.schedule.jitterSeconds >= 0, "Jitter must be positive");

    const level: LogLevel[] = ["error", "warn", "info", "debug"];
    assert(level.includes(config.logging.level), "Invalid logging level");

    return {
        ...config,
        version: CONFIG_VERSION,
        repo: {
            ...config.repo,
            remote: config.repo.remote || "origin",
        },
        workspace: {
            ...config.workspace,
            installCommand: config.workspace.installCommand || "npm install",
        },
        schedule: {
            intervalSeconds: Math.max(15, config.schedule.intervalSeconds),
            jitterSeconds: Math.max(0, config.schedule.jitterSeconds),
        },
    };
}
