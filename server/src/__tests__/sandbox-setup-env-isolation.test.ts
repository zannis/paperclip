import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { execute as claudeExecute } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute } from "@paperclipai/adapter-codex-local/server";
import { execute as piExecute, testEnvironment as piTestEnvironment } from "@paperclipai/adapter-pi-local/server";
import { testEnvironment as opencodeTestEnvironment } from "@paperclipai/adapter-opencode-local/server";
import { resolveClaudeExecutionEngineForRun } from "../../../packages/adapters/claude-local/src/server/acp.js";
import { resolveCodexExecutionEngineForRun } from "../../../packages/adapters/codex-local/src/server/acp.js";
import { resolveGeminiExecutionEngineForRun } from "../../../packages/adapters/gemini-local/src/server/acp.js";
import { resolveKimiExecutionEngineForRun } from "../../../packages/adapters/kimi-local/src/server/acp.js";

// Values only the server process holds. None may reach a sandbox exec.
const SERVER_SECRETS = {
  PAPERCLIP_AGENT_JWT_SECRET: "server-jwt-signing-key-canary",
  SANDBOX_ENV_ISOLATION_SERVER_ONLY: "server-only-value-canary",
};

type RecordedExec = { command: string; args: string[]; env: Record<string, string> };

// A sandbox runner that runs commands on this host, records every exec's env,
// reports the listed commands as missing until their install runs, and never
// runs an install command for real.
function createRecordingSandboxRunner(missing: Map<string, (script: string) => boolean>) {
  const calls: RecordedExec[] = [];
  let counter = 0;
  const done = (exitCode: number) => ({
    exitCode,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
  });
  const runner = {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      const args = input.args ?? [];
      calls.push({ command: input.command, args, env: { ...(input.env ?? {}) } });
      const script = args.join(" ");
      const probed = /command -v '([^']+)'/.exec(script)?.[1];
      if (probed && missing.has(probed)) return done(1);
      for (const [name, isInstall] of missing) {
        if (isInstall(script)) {
          missing.delete(name);
          return done(0);
        }
      }
      counter += 1;
      return runChildProcess(`sandbox-exec-${counter}`, input.command, args, {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
        onSpawn: input.onSpawn
          ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
          : undefined,
      });
    },
  };
  return { runner, calls };
}

function sandboxTarget(runner: unknown, remoteCwd: string): AdapterExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    environmentId: "env-1",
    leaseId: "lease-1",
    remoteCwd,
    timeoutMs: 30_000,
    runner,
  } as AdapterExecutionTarget;
}

// Sandbox providers export this env into the exec command line, so a server
// value here is a server value inside the sandbox. Names only, never values,
// so a failure cannot print a secret.
function serverSecretLeaks(calls: RecordedExec[]): string[] {
  const leaks: string[] = [];
  for (const call of calls) {
    const exec = [call.command, ...call.args].join(" ").slice(0, 80);
    for (const [key, secret] of Object.entries(SERVER_SECRETS)) {
      if (Object.values(call.env).includes(secret)) leaks.push(`${key} in env of: ${exec}`);
    }
  }
  return leaks;
}

function probedCommands(calls: RecordedExec[]): string[] {
  return calls
    .map((call) => /command -v '([^']+)'/.exec(call.args.join(" "))?.[1])
    .filter((name): name is string => typeof name === "string");
}

const isNpmInstall = (script: string) => script.includes("npm install -g");
const isRuntimeSpecInstall = (script: string) => script.includes("install-agent-runtime");

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await fs.writeFile(filePath, `#!/usr/bin/env node\n${body}`, "utf8");
  await fs.chmod(filePath, 0o755);
}

const FAKE_CLAUDE = `
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "11111111-1111-4111-8111-111111111111", usage: { input_tokens: 1, output_tokens: 1 } }));
`;
const FAKE_CODEX = `
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
const FAKE_HELLO = `
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }));
`;

describe("sandbox setup execs never carry the server's env", () => {
  let root: string;
  let binDir: string;
  let localWorkspace: string;
  let remoteWorkspace: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-setup-env-"));
    binDir = path.join(root, "bin");
    localWorkspace = path.join(root, "workspace");
    remoteWorkspace = path.join(root, "remote");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(localWorkspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    Object.assign(process.env, SERVER_SECRETS);
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(root, { recursive: true, force: true });
  });

  const agent = (adapterType: string) => ({
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    adapterType,
    adapterConfig: { engine: "cli" },
  });
  const runtime = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null };
  const runtimeCommandSpec = (command: string) => ({
    command,
    detectCommand: "agent-runtime-detect",
    installCommand: "install-agent-runtime",
  });

  it("claude_local: runtime install, resolvability probe and its install fallback", async () => {
    const commandPath = path.join(binDir, "claude");
    await writeExecutable(commandPath, FAKE_CLAUDE);
    const { runner, calls } = createRecordingSandboxRunner(new Map([
      ["agent-runtime-detect", isRuntimeSpecInstall],
      [commandPath, isNpmInstall],
    ]));

    await claudeExecute({
      runId: "run-claude",
      agent: agent("claude_local"),
      runtime,
      config: { engine: "cli", command: commandPath, cwd: localWorkspace, promptTemplate: "hi" },
      context: {},
      runtimeCommandSpec: runtimeCommandSpec(commandPath),
      executionTarget: sandboxTarget(runner, remoteWorkspace),
      authToken: "run-jwt-token",
      onLog: async () => {},
    });

    expect(probedCommands(calls)).toEqual(expect.arrayContaining(["agent-runtime-detect", commandPath]));
    expect(calls.some((call) => isNpmInstall(call.args.join(" ")))).toBe(true);
    expect(serverSecretLeaks(calls)).toEqual([]);
  }, 30_000);

  it("codex_local: runtime install and resolvability probe", async () => {
    const commandPath = path.join(binDir, "codex");
    await writeExecutable(commandPath, FAKE_CODEX);
    const { runner, calls } = createRecordingSandboxRunner(new Map([
      ["agent-runtime-detect", isRuntimeSpecInstall],
    ]));

    await codexExecute({
      runId: "run-codex",
      agent: agent("codex_local"),
      runtime,
      config: {
        engine: "cli",
        command: commandPath,
        cwd: localWorkspace,
        env: { OPENAI_API_KEY: "sk-test-run-key" },
        promptTemplate: "hi",
      },
      context: {},
      runtimeCommandSpec: runtimeCommandSpec(commandPath),
      executionTarget: sandboxTarget(runner, remoteWorkspace),
      authToken: "run-jwt-token",
      onLog: async () => {},
    });

    expect(probedCommands(calls)).toEqual(expect.arrayContaining(["agent-runtime-detect", commandPath]));
    expect(serverSecretLeaks(calls)).toEqual([]);
  }, 30_000);

  it("pi_local: runtime install, resolvability probe and its install fallback", async () => {
    const commandPath = path.join(binDir, "pi");
    await writeExecutable(commandPath, FAKE_HELLO);
    const { runner, calls } = createRecordingSandboxRunner(new Map([
      ["agent-runtime-detect", isRuntimeSpecInstall],
      [commandPath, isNpmInstall],
    ]));

    await piExecute({
      runId: "run-pi",
      agent: agent("pi_local"),
      runtime,
      config: { command: commandPath, cwd: localWorkspace, model: "anthropic/claude-sonnet", promptTemplate: "hi" },
      context: {},
      runtimeCommandSpec: runtimeCommandSpec(commandPath),
      executionTarget: sandboxTarget(runner, remoteWorkspace),
      authToken: "run-jwt-token",
      onLog: async () => {},
    }).catch(() => undefined);

    expect(probedCommands(calls)).toEqual(expect.arrayContaining(["agent-runtime-detect", commandPath]));
    expect(calls.some((call) => isNpmInstall(call.args.join(" ")))).toBe(true);
    expect(serverSecretLeaks(calls)).toEqual([]);
  }, 30_000);

  it.each([
    ["claude", resolveClaudeExecutionEngineForRun, "claude-agent-acp"],
    ["codex", resolveCodexExecutionEngineForRun, "codex-acp"],
    ["gemini", resolveGeminiExecutionEngineForRun, "gemini"],
    ["kimi", resolveKimiExecutionEngineForRun, "kimi"],
  ] as const)("%s ACP engine resolution probe", async (_name, resolveEngine, agentCommand) => {
    const { runner, calls } = createRecordingSandboxRunner(new Map());

    await resolveEngine({
      config: { engine: "acp", agentCommand, acpAgentCommand: agentCommand, command: agentCommand, cwd: localWorkspace },
      executionTarget: sandboxTarget(runner, remoteWorkspace),
    });

    expect(probedCommands(calls).length).toBeGreaterThan(0);
    expect(serverSecretLeaks(calls)).toEqual([]);
  }, 30_000);

  it("pi_local testEnvironment: resolvability and hello probes", async () => {
    const commandPath = path.join(binDir, "pi");
    await writeExecutable(commandPath, FAKE_HELLO);
    const { runner, calls } = createRecordingSandboxRunner(new Map());

    await piTestEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      config: { command: commandPath, cwd: remoteWorkspace, model: "anthropic/claude-sonnet" },
      executionTarget: sandboxTarget(runner, remoteWorkspace),
    });

    expect(probedCommands(calls)).toContain(commandPath);
    expect(calls.some((call) => call.args.includes("Respond with hello."))).toBe(true);
    expect(serverSecretLeaks(calls)).toEqual([]);
  }, 30_000);

  it("opencode_local testEnvironment: resolvability and hello probes", async () => {
    const commandPath = path.join(binDir, "opencode");
    await writeExecutable(commandPath, FAKE_HELLO);
    const { runner, calls } = createRecordingSandboxRunner(new Map());

    await opencodeTestEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: { command: commandPath, cwd: remoteWorkspace, model: "anthropic/claude-sonnet" },
      executionTarget: sandboxTarget(runner, remoteWorkspace),
    });

    expect(probedCommands(calls)).toContain(commandPath);
    expect(calls.some((call) => call.command === commandPath && call.args.includes("run"))).toBe(true);
    expect(serverSecretLeaks(calls)).toEqual([]);
  }, 30_000);
});
