import axios from "axios";

export async function getLatestCommit(repoUrl: string, branch: string): Promise<string> {
    if (repoUrl.includes("github.com")) {
        const [owner, repo] = repoUrl.split("github.com/")[1].split("/");
        const apiUrl = `https://api.github.com/repos/${owner}/${repo.replace(".git", "")}/commits/${branch}`;
        const res = await axios.get(apiUrl, { headers: { "User-Agent": "git-updater" } });
        return res.data.sha;
    }

    if (repoUrl.includes("gitlab.com")) {
        const project = encodeURIComponent(repoUrl.split("gitlab.com/")[1].replace(".git", ""));
        const apiUrl = `https://gitlab.com/api/v4/projects/${project}/repository/branches/${branch}`;
        const res = await axios.get(apiUrl);
        return res.data.commit.id;
    }

    throw new Error("Unsupported repository host");
}
