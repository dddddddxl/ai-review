import fs from "node:fs";

import { App } from "octokit";

for (const name of [
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_URL",
]) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const webhookUrl = new URL(process.env.GITHUB_WEBHOOK_URL);
const allowInsecureHttp =
  process.env.GITHUB_WEBHOOK_ALLOW_INSECURE_HTTP === "true";
if (
  webhookUrl.protocol !== "https:" &&
  !(webhookUrl.protocol === "http:" && allowInsecureHttp)
) {
  throw new Error(
    "GITHUB_WEBHOOK_URL must use HTTPS; explicitly allow HTTP only for a public test repository",
  );
}
if (webhookUrl.pathname !== "/api/webhook") {
  throw new Error("GITHUB_WEBHOOK_URL must end with /api/webhook");
}

const app = new App({
  appId: process.env.GITHUB_APP_ID,
  privateKey: fs.readFileSync(
    process.env.GITHUB_PRIVATE_KEY_PATH,
    "utf8",
  ),
});

const authentication = await app.octokit.auth({ type: "app" });
const response = await fetch("https://api.github.com/app/hook/config", {
  method: "PATCH",
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${authentication.token}`,
    "content-type": "application/json",
    "user-agent": "github-ai-reviewer",
    "x-github-api-version": "2022-11-28",
  },
  body: JSON.stringify({
    url: webhookUrl.toString(),
    content_type: "json",
    insecure_ssl: "0",
  }),
});

const responseBody = await response.json();
if (!response.ok) {
  throw new Error(
    `GitHub rejected webhook update (${response.status}): ${responseBody.message ?? "unknown error"}`,
  );
}

console.log(
  JSON.stringify({
    contentType: responseBody.content_type,
    insecureSsl: responseBody.insecure_ssl,
    url: responseBody.url,
    insecureHttp: webhookUrl.protocol === "http:",
  }),
);
