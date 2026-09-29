import fs from "node:fs";

import { App } from "octokit";

for (const name of ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_PATH"]) {
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

const appResponse = await app.octokit.request("GET /app");
const webhookResponse = await app.octokit.request("GET /app/hook/config");
const installations = await app.octokit.paginate(
  "GET /app/installations",
  { per_page: 100 },
);

const installationDetails = await Promise.all(
  installations.map(async (installation) => {
    const octokit = await app.getInstallationOctokit(installation.id);
    const repositories = await octokit.paginate(
      "GET /installation/repositories",
      { per_page: 100 },
    );

    return {
      account: installation.account?.login || null,
      events: installation.events,
      id: installation.id,
      permissions: installation.permissions,
      repositories: repositories.map(
        (repository) => repository.full_name,
      ),
      repositorySelection: installation.repository_selection,
    };
  }),
);

console.log(
  JSON.stringify(
    {
      app: {
        events: appResponse.data.events,
        id: appResponse.data.id,
        name: appResponse.data.name,
        permissions: appResponse.data.permissions,
        slug: appResponse.data.slug,
        webhook: {
          contentType: webhookResponse.data.content_type,
          insecureSsl: webhookResponse.data.insecure_ssl,
          url: webhookResponse.data.url,
        },
      },
      installations: installationDetails,
    },
    null,
    2,
  ),
);
