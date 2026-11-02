import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  main as deployMain,
  readDeployConfig,
  uploadBundle,
  validateConfig,
} from "../scripts/deploy-test-server.mjs";

describe("private test-server workflow", () => {
  it("prepares a credential-free sandbox deploy bundle", () => {
    const output = execFileSync("node", ["scripts/deploy-test-server.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SCREEPS_SERVER_URL: "http://deploy-user:deploy-pass@localhost:21025",
        SCREEPS_BRANCH: "agent-sandbox",
        SCREEPS_TOKEN: "secret-token",
      },
    });

    expect(output).toContain("Prepared Screeps private/test-server deploy bundle");
    expect(output).toContain("branch: agent-sandbox");
    expect(output).toContain("server: http://localhost:21025");
    expect(output).not.toContain("deploy-user");
    expect(output).not.toContain("deploy-pass");

    const bundlePath = join(process.cwd(), "dist", "main.js");
    expect(existsSync(bundlePath)).toBe(true);

    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).toContain("Target: http://redacted:redacted@localhost:21025 / branch agent-sandbox");
    expect(bundle).not.toContain("secret-token");
    expect(bundle).not.toContain("deploy-user");
    expect(bundle).not.toContain("deploy-pass");
  });

  it("refuses non-dry-run mode without a token", () => {
    expect(() =>
      execFileSync("node", ["scripts/deploy-test-server.mjs"], {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_DRY_RUN: "0",
          SCREEPS_TOKEN: "",
        },
      }),
    ).toThrow(/SCREEPS_TOKEN/);
  });

  it("prints a status smoke report", () => {
    const output = execFileSync("node", ["scripts/test-server-status.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SCREEPS_SERVER_URL: "http://status-user:status-pass@localhost:21025",
        SCREEPS_BRANCH: "agent-sandbox",
      },
    });

    expect(output).toContain("Screeps private/test-server status smoke");
    expect(output).toContain("server: http://localhost:21025");
    expect(output).toContain("branch: agent-sandbox");
    expect(output).toContain("final RCL:");
    expect(output).toContain("failures: 0");
    expect(output).not.toContain("status-user");
    expect(output).not.toContain("status-pass");
  });

  it("generates a local-server proof block without leaking tokens", () => {
    const output = execFileSync(
      "node",
      ["scripts/local-server-proof.mjs", "--compose-dir", "does-not-exist", "--markdown"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_SERVER_URL: "http://localhost:21025",
          SCREEPS_BRANCH: "agent-sandbox",
          SCREEPS_TOKEN: "super-secret-token",
        },
      },
    );

    expect(output).toContain("## Local Screeps private-server proof");
    expect(output).toContain("Server URL: http://localhost:21025");
    expect(output).toContain("Branch: agent-sandbox");
    expect(output).toContain("Token configured: yes (redacted)");
    expect(output).toContain("docker-compose.yml not found");
    expect(output).not.toContain("super-secret-token");
  });

  it("redacts URL credentials from local-server proof output", () => {
    const output = execFileSync(
      "node",
      ["scripts/local-server-proof.mjs", "--compose-dir", "does-not-exist", "--markdown"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SCREEPS_SERVER_URL: "http://local-user:local-pass@localhost:21025",
          SCREEPS_BRANCH: "agent-sandbox",
          SCREEPS_TOKEN: "super-secret-token",
        },
      },
    );

    expect(output).toContain("Server URL: http://localhost:21025");
    expect(output).not.toContain("local-user");
    expect(output).not.toContain("local-pass");
    expect(output).not.toContain("super-secret-token");
  });

  it("uses the local Compose env file when proof capture has one", () => {
    const output = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
          import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { buildComposeArgs } from "./scripts/local-server-proof.mjs";

          const dir = mkdtempSync(join(tmpdir(), "screeps-proof-"));
          try {
            const composeFile = join(dir, "docker-compose.yml");
            const envFile = join(dir, ".env");
            writeFileSync(composeFile, "services: {}\\n", "utf8");
            writeFileSync(envFile, "SCREEPS_LAUNCHER_HOST=127.0.0.1\\n", "utf8");
            console.log(JSON.stringify(buildComposeArgs({ composeFile, envFile, args: ["ps"] })));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        `,
      ],
      { encoding: "utf8" },
    );

    const args = JSON.parse(output);
    expect(args).toContain("--env-file");
    expect(args.some((arg: string) => arg.endsWith(".env"))).toBe(true);
    expect(args).toEqual(expect.arrayContaining(["compose", "-f", "ps"]));
  });
});

describe("deploy config validation", () => {
  const fullEnv = {
    SCREEPS_SERVER_URL: "http://localhost:21025",
    SCREEPS_USERNAME: "upload-user",
    SCREEPS_TOKEN: "upload-token-123",
    SCREEPS_BRANCH: "agent-sandbox",
  };

  it("defaults to dry-run and accepts an empty env", () => {
    const config = readDeployConfig({});
    expect(config.dryRun).toBe(true);
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("lists every missing variable for a real upload", () => {
    const config = readDeployConfig({ SCREEPS_DRY_RUN: "0" });
    expect(() => validateConfig(config)).toThrow(
      /SCREEPS_SERVER_URL, SCREEPS_USERNAME, SCREEPS_TOKEN, SCREEPS_BRANCH/,
    );
  });

  it("requires the token specifically for a real upload", () => {
    const { SCREEPS_TOKEN: _token, ...rest } = fullEnv;
    const config = readDeployConfig({ ...rest, SCREEPS_DRY_RUN: "0" });
    expect(() => validateConfig(config)).toThrow(/SCREEPS_TOKEN/);
  });

  it("accepts a complete real-upload config", () => {
    const config = readDeployConfig({ ...fullEnv, SCREEPS_DRY_RUN: "0" });
    expect(config.dryRun).toBe(false);
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects invalid URLs and branches", () => {
    expect(() => validateConfig(readDeployConfig({ SCREEPS_SERVER_URL: "ftp://localhost" }))).toThrow(
      /http/,
    );
    expect(() => validateConfig(readDeployConfig({ SCREEPS_SERVER_URL: "not a url" }))).toThrow(
      /SCREEPS_SERVER_URL/,
    );
    expect(() => validateConfig(readDeployConfig({ SCREEPS_BRANCH: "bad branch!" }))).toThrow(
      /SCREEPS_BRANCH/,
    );
  });

  it("refuses real-account screeps.com targets", () => {
    for (const url of ["https://screeps.com", "https://www.screeps.com"]) {
      expect(() =>
        validateConfig(readDeployConfig({ ...fullEnv, SCREEPS_SERVER_URL: url, SCREEPS_DRY_RUN: "0" })),
      ).toThrow(/out of scope/);
    }
  });

  it("does not expose the token when the config is serialized", () => {
    const config = readDeployConfig(fullEnv);
    expect(JSON.stringify(config)).not.toContain("upload-token-123");
  });
});

describe("deploy upload", () => {
  const env = {
    SCREEPS_SERVER_URL: "http://url-user:url-pass@localhost:21025",
    SCREEPS_USERNAME: "upload-user",
    SCREEPS_TOKEN: "upload-token-123",
    SCREEPS_BRANCH: "agent-sandbox",
    SCREEPS_DRY_RUN: "0",
  };

  it("does not call fetch in dry-run mode", async () => {
    const fetchImpl = vi.fn();
    const logs: string[] = [];
    await deployMain(
      { ...env, SCREEPS_DRY_RUN: undefined },
      { fetchImpl, log: (message: string) => logs.push(message) },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("dry-run: no upload performed");
    expect(logs.join("\n")).not.toContain("upload-token-123");
  });

  it("uploads with the token header and never logs the token", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: 1 }),
    }));
    const logs: string[] = [];
    await deployMain(env, { fetchImpl, log: (message: string) => logs.push(message) });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("http://localhost:21025/api/user/code");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Token"]).toBe("upload-token-123");
    const body = JSON.parse(init.body);
    expect(body.branch).toBe("agent-sandbox");
    expect(typeof body.modules.main).toBe("string");
    expect(init.body).not.toContain("upload-token-123");

    const output = logs.join("\n");
    expect(output).toContain("uploaded: branch agent-sandbox");
    expect(output).not.toContain("upload-token-123");
    expect(output).not.toContain("url-user");
    expect(output).not.toContain("url-pass");
  });

  it("redacts the token from network errors", async () => {
    const config = readDeployConfig(env);
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect failed token=upload-token-123 X-Token upload-token-123");
    });
    await expect(uploadBundle({ config, code: "x", env, fetchImpl })).rejects.toThrow(
      /Upload request failed/,
    );
    await uploadBundle({ config, code: "x", env, fetchImpl }).catch((error: Error) => {
      expect(error.message).not.toContain("upload-token-123");
    });
  });

  it("fails on HTTP errors and server-side rejections without leaking the token", async () => {
    const config = readDeployConfig(env);

    const httpFail = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(uploadBundle({ config, code: "x", env, fetchImpl: httpFail })).rejects.toThrow(
      /HTTP 401/,
    );

    const rejected = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: "bad token upload-token-123" }),
    }));
    await uploadBundle({ config, code: "x", env, fetchImpl: rejected }).then(
      () => {
        throw new Error("expected rejection");
      },
      (error: Error) => {
        expect(error.message).toContain("rejected by server");
        expect(error.message).not.toContain("upload-token-123");
      },
    );
  });
});
