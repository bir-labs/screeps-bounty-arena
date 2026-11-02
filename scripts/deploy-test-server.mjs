#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildMaskedReportUrl,
  redactPrivateServerText,
  stripUrlUserInfo,
} from "./redact-url.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const REQUIRED_FOR_UPLOAD = [
  ["SCREEPS_SERVER_URL", "serverUrl"],
  ["SCREEPS_USERNAME", "username"],
  ["SCREEPS_TOKEN", "token"],
  ["SCREEPS_BRANCH", "branch"],
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Error: ${redactPrivateServerText(message, process.env, { redactKnownTokenPatterns: true })}`,
    );
    process.exit(1);
  });
}

export async function main(env, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const config = readDeployConfig(env);
  validateConfig(config);

  const distDir = join(repoRoot, "dist");
  const outputPath = join(distDir, "main.js");
  const bundle = buildDeployBundle(config);

  mkdirSync(distDir, { recursive: true });
  writeFileSync(outputPath, bundle, "utf8");

  log("Prepared Screeps private/test-server deploy bundle");
  log(`branch: ${config.branch}`);
  log(`server: ${stripUrlUserInfo(config.serverUrl)}`);
  log(`bundle: ${relative(repoRoot, outputPath)}`);

  if (config.dryRun) {
    log(
      `dry-run: no upload performed (${Buffer.byteLength(bundle, "utf8")} bytes ready). Set SCREEPS_DRY_RUN=0 with SCREEPS_SERVER_URL, SCREEPS_USERNAME, SCREEPS_TOKEN and SCREEPS_BRANCH to upload to a local/private server.`,
    );
    return;
  }

  await uploadBundle({ config, code: bundle, env, fetchImpl });
  log(`uploaded: branch ${config.branch} on ${stripUrlUserInfo(config.serverUrl)}`);
}

export function readDeployConfig(env) {
  const config = {
    serverUrl: env.SCREEPS_SERVER_URL || "http://127.0.0.1:21025",
    username: env.SCREEPS_USERNAME || "local-test-user",
    branch: env.SCREEPS_BRANCH || "sandbox",
    dryRun: env.SCREEPS_DRY_RUN !== "0",
    hasToken: Boolean(env.SCREEPS_TOKEN),
    missing: REQUIRED_FOR_UPLOAD.filter(([name]) => !env[name]).map(([name]) => name),
  };

  // Non-enumerable so logging or serializing the config can never leak the token.
  Object.defineProperty(config, "token", {
    value: env.SCREEPS_TOKEN || "",
    enumerable: false,
  });

  return config;
}

export function validateConfig(config) {
  let parsed;
  try {
    parsed = new URL(config.serverUrl);
  } catch {
    throw new Error("SCREEPS_SERVER_URL must be a valid http:// or https:// URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SCREEPS_SERVER_URL must start with http:// or https://");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "screeps.com" || hostname.endsWith(".screeps.com")) {
    throw new Error(
      "Real-account Screeps deploys are out of scope; SCREEPS_SERVER_URL must point to a local/private server",
    );
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(config.branch)) {
    throw new Error(
      "SCREEPS_BRANCH may only contain letters, numbers, dots, underscores, and dashes",
    );
  }

  if (!config.dryRun && config.missing && config.missing.length > 0) {
    throw new Error(
      `Missing required environment for real upload (SCREEPS_DRY_RUN=0): ${config.missing.join(", ")}`,
    );
  }

  if (!config.dryRun && !config.hasToken) {
    throw new Error("Set SCREEPS_TOKEN before running with SCREEPS_DRY_RUN=0");
  }
}

export async function uploadBundle({ config, code, env, fetchImpl = globalThis.fetch }) {
  const redact = (value) =>
    redactPrivateServerText(value, env, { redactKnownTokenPatterns: true });

  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available for upload");
  }

  const endpoint = `${stripUrlUserInfo(config.serverUrl)}/api/user/code`;
  let response;

  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Token": config.token,
      },
      body: JSON.stringify({ branch: config.branch, modules: { main: code } }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Upload request failed: ${redact(message)}`);
  }

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (body && (body.error || body.ok === 0)) {
    throw new Error(`Upload rejected by server: ${redact(String(body.error || "ok=0"))}`);
  }
}

export function buildDeployBundle(config) {
  const mainPath = join(repoRoot, "src", "main.ts");
  const source = existsSync(mainPath)
    ? readFileSync(mainPath, "utf8")
    : "export const loop = () => {};\n";

  return [
    "// Generated by scripts/deploy-test-server.mjs for private/test-server verification.",
    "// This bundle intentionally contains no Screeps credentials.",
    `// Target: ${buildMaskedReportUrl(config.serverUrl)} / branch ${config.branch}`,
    "// The current repo uses TypeScript source directly; wire a real bundler before production deploy.",
    source,
    "",
  ].join("\n");
}
