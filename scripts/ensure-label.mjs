import fs from "node:fs";

import { App } from "octokit";

for (const name of [
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY_PATH",
]) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const app = new App({
  appId: process.env.GITHUB_APP_ID,
  privateKey: fs.readFileSync(
    process.env.GITHUB_PRIVATE_KEY_PATH,
    "utf8",
  ),
});

const label = process.env.AI_REVIEW_LABEL || "ai-review";
const repositories = (process.env.ALLOWED_REPOSITORIES || "").split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (repositories.length === 0) {
  const installations = await app.octokit.paginate("GET /app/installations", { per_page: 100 });
  for (const installation of installations) {
    if (installation.suspended_at) continue;
    const octokit = await app.getInstallationOctokit(installation.id);
    const installed = await octokit.paginate("GET /installation/repositories", { per_page: 100 });
    repositories.push(...installed.map((repository) => repository.full_name));
  }
}

for (const fullName of repositories) {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }

  const installation = await app.octokit.request(
    "GET /repos/{owner}/{repo}/installation",
    { owner, repo },
  );
  const octokit = await app.getInstallationOctokit(
    installation.data.id,
  );

  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: label });
    console.log(`[Label] exists repository=${fullName} label=${label}`);
  } catch (error) {
    if (error?.status !== 404) throw error;
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: label,
      color: "6f42c1",
      description: "Trigger the GitHub AI reviewer",
    });
    console.log(`[Label] created repository=${fullName} label=${label}`);
  }
}
