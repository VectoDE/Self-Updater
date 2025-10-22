import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import simpleGit, { SimpleGit } from "simple-git";
import { UpdaterConfig } from "./config";
import { logger } from "./logger";

const execAsync = promisify(exec);

interface UpdateResult {
    updated: boolean;
    previousCommit?: string;
    currentCommit?: string;
}

export class UpdateManager {
    private git: SimpleGit;
    private readonly lockFile: string;

    constructor(private readonly config: UpdaterConfig) {
        this.git = simpleGit({ baseDir: config.workspace.localPath });
        this.lockFile = path.join(config.workspace.localPath, ".self-updater.lock");
    }

    async ensureRepository() {
        if (!fs.existsSync(this.config.workspace.localPath)) {
            fs.mkdirSync(this.config.workspace.localPath, { recursive: true });
        }

        const gitDir = path.join(this.config.workspace.localPath, ".git");
        const exists = fs.existsSync(gitDir);
        if (!exists) {
            const directoryEntries = fs.readdirSync(this.config.workspace.localPath);
            if (directoryEntries.length > 0) {
                throw new Error(
                    `Local path ${this.config.workspace.localPath} exists but is not an empty git repository`,
                );
            }

            logger.info("Cloning repository", {
                url: this.config.repo.url,
                branch: this.config.repo.branch,
            });

            await simpleGit().clone(this.config.repo.url, this.config.workspace.localPath, [
                "--branch",
                this.config.repo.branch,
                "--single-branch",
                ...(this.config.workspace.shallowClone ? ["--depth", "1"] : []),
            ]);
        }
    }

    async getCurrentCommit(): Promise<string | undefined> {
        try {
            return await this.git.revparse(["HEAD"]);
        } catch (error) {
            logger.debug("Failed to resolve current commit", {
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }

    private async acquireLock() {
        try {
            await fsPromises.open(this.lockFile, "wx");
        } catch (error) {
            throw new Error("Another update is already running");
        }
    }

    private async releaseLock() {
        await fsPromises.rm(this.lockFile, { force: true });
    }

    private async runHook(name: "pre" | "post", command?: string) {
        if (!command) {
            return;
        }

        logger.info(`Executing ${name}-update hook`, { command });
        await this.runCommand(command, { cwd: this.config.workspace.localPath });
    }

    private resolveRestartCommand() {
        if (this.config.service.restartCommand) {
            return this.config.service.restartCommand;
        }

        if (this.config.service.type === "pm2") {
            return `pm2 reload ${this.config.service.name}`;
        }

        if (this.config.service.type === "docker") {
            if (this.config.service.dockerCompose) {
                const segments = ["docker", "compose"];
                if (this.config.service.dockerComposeFile) {
                    segments.push("-f", this.config.service.dockerComposeFile);
                }
                segments.push("restart");
                segments.push(this.config.service.dockerComposeService || this.config.service.name || "");
                return segments.join(" ").trim();
            }
            return `docker restart ${this.config.service.name}`;
        }

        return this.config.service.restartCommand;
    }

    private async runCommand(command: string, options: { cwd?: string } = {}) {
        const execOptions = {
            cwd: options.cwd ?? this.config.workspace.localPath,
            env: { ...process.env },
            maxBuffer: 10 * 1024 * 1024,
        };

        try {
            const { stdout, stderr } = await execAsync(command, execOptions);
            if (stdout?.trim()) {
                logger.info(stdout.trim());
            }
            if (stderr?.trim()) {
                logger.warn(stderr.trim());
            }
        } catch (error) {
            const err = error as { stdout?: string; stderr?: string; message: string };
            if (err.stdout?.trim()) {
                logger.info(err.stdout.trim());
            }
            if (err.stderr?.trim()) {
                logger.error(`Command error output`, { stderr: err.stderr.trim() });
            }
            throw error;
        }
    }

    private async installDependencies(previousCommit?: string, currentCommit?: string) {
        if (!this.config.workspace.autoInstall) {
            return;
        }

        const installCommand = this.config.workspace.installCommand || "npm install";
        if (!previousCommit || !currentCommit) {
            logger.info("Running install command (initial deployment)", { installCommand });
            await this.runCommand(installCommand);
            return;
        }

        const diff = await this.git.diff([
            `${previousCommit}..${currentCommit}`,
            "--",
            "package.json",
            "package-lock.json",
            "yarn.lock",
            "pnpm-lock.yaml",
        ]);

        if (diff.trim().length === 0) {
            logger.debug("No dependency changes detected");
            return;
        }

        logger.info("Dependencies changed – running install command", { installCommand });
        await this.runCommand(installCommand);
    }

    async updateToCommit(remoteCommit: string): Promise<UpdateResult> {
        await this.ensureRepository();
        await this.acquireLock();
        try {
            const previousCommit = await this.getCurrentCommit();

            logger.info("Fetching latest changes", {
                branch: this.config.repo.branch,
                remote: this.config.repo.remote,
            });

            await this.git.fetch(this.config.repo.remote, this.config.repo.branch);

            const status = await this.git.status();
            const requiresUpdate = status.behind > 0 || previousCommit !== remoteCommit;
            if (!requiresUpdate) {
                logger.debug("Repository already up to date");
                return { updated: false, previousCommit, currentCommit: previousCommit };
            }

            await this.runHook("pre", this.config.hooks.preUpdate);

            await this.git.reset(["--hard", `${this.config.repo.remote}/${this.config.repo.branch}`]);

            const currentCommit = await this.getCurrentCommit();

            await this.installDependencies(previousCommit, currentCommit);

            const restartCommand = this.resolveRestartCommand();
            if (restartCommand) {
                logger.info("Restarting service", { command: restartCommand });
                await this.runCommand(restartCommand);
            }

            await this.runHook("post", this.config.hooks.postUpdate);

            logger.info("Update complete", { previousCommit, currentCommit });
            return { updated: true, previousCommit, currentCommit };
        } finally {
            await this.releaseLock();
        }
    }
}
