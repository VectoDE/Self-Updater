import axios, { AxiosInstance } from "axios";
import simpleGit from "simple-git";
import { UpdaterConfig } from "./config";
import { logger } from "./logger";

export type GitProvider = "github" | "gitlab" | "unknown";

interface ProviderDetails {
    provider: GitProvider;
    owner?: string;
    repository?: string;
    projectPath?: string;
}

function parseRepository(config: UpdaterConfig): ProviderDetails {
    try {
        const url = new URL(config.repo.url);
        const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);

        if (url.hostname.includes("github.com")) {
            return {
                provider: "github",
                owner: segments[0],
                repository: segments[1],
            };
        }

        if (url.hostname.includes("gitlab")) {
            return {
                provider: "gitlab",
                projectPath: segments.join("/"),
            };
        }
    } catch (error) {
        logger.warn("Failed to parse repository URL", { error: (error as Error).message });
    }

    return { provider: "unknown" };
}

export class RepositoryWatcher {
    private axios: AxiosInstance;
    private etag?: string;
    private lastCommit?: string;

    constructor(private readonly config: UpdaterConfig) {
        this.axios = axios.create({
            timeout: 15000,
            headers: {
                "User-Agent": "self-updater/2.0",
                Accept: "application/vnd.github+json, application/json",
            },
        });

        if (config.repo.authToken) {
            this.axios.defaults.headers.common.Authorization = `Bearer ${config.repo.authToken}`;
        }
    }

    async getLatestCommit(): Promise<string> {
        const details = parseRepository(this.config);

        try {
            if (details.provider === "github") {
                return await this.fetchFromGitHub(details);
            }

            if (details.provider === "gitlab") {
                return await this.fetchFromGitLab(details);
            }
        } catch (error) {
            logger.warn("Falling back to git ls-remote", {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return this.fetchWithGit();
    }

    private async fetchFromGitHub(details: ProviderDetails) {
        if (!details.owner || !details.repository) {
            throw new Error("Incomplete GitHub repository details");
        }

        const apiUrl = `https://api.github.com/repos/${details.owner}/${details.repository}/commits/${this.config.repo.branch}`;

        const response = await this.axios.get(apiUrl, {
            headers: this.etag
                ? {
                      "If-None-Match": this.etag,
                  }
                : undefined,
            validateStatus: (status) => [200, 304].includes(status),
        });

        if (response.status === 304) {
            if (this.lastCommit) {
                return this.lastCommit;
            }
            return this.fetchWithGit();
        }

        this.etag = response.headers.etag;
        this.lastCommit = response.data.sha as string;
        return this.lastCommit;
    }

    private async fetchFromGitLab(details: ProviderDetails) {
        if (!details.projectPath) {
            throw new Error("Incomplete GitLab project path");
        }

        const apiUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(details.projectPath)}/repository/branches/${this.config.repo.branch}`;
        const response = await this.axios.get(apiUrl, {
            headers: this.etag
                ? {
                      "If-None-Match": this.etag,
                  }
                : undefined,
            validateStatus: (status) => [200, 304].includes(status),
        });

        if (response.status === 304) {
            if (this.lastCommit) {
                return this.lastCommit;
            }
            return this.fetchWithGit();
        }

        this.etag = response.headers.etag;
        this.lastCommit = response.data.commit.id as string;
        return this.lastCommit;
    }

    private async fetchWithGit() {
        const git = simpleGit();
        const output = await git.listRemote([
            "--heads",
            this.config.repo.url,
            this.config.repo.branch,
        ]);

        const lines = output
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

        const match = lines.find((line) => line.endsWith(`refs/heads/${this.config.repo.branch}`));
        if (!match) {
            throw new Error(`Unable to resolve commit for branch ${this.config.repo.branch}`);
        }

        this.lastCommit = match.split("\t")[0];
        return this.lastCommit;
    }
}
