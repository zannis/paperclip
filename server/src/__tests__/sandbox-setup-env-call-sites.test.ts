import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// adapter-utils drops host-equal values from sandbox setup envs, which would
// hide a call site that merged process.env back in. Record the env each
// adapter hands to the setup entry points, before that guard runs, and stop
// at the resolvability probe.
const setup = vi.hoisted(() => ({
  calls: [] as Array<{ transport: string; env: Record<string, string | undefined> }>,
  stop: new Error("setup probe reached"),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  const record = (target: AdapterExecutionTarget | null | undefined, env: NodeJS.ProcessEnv) => {
    setup.calls.push({ transport: target?.kind === "remote" ? target.transport : "local", env: { ...env } });
  };
  return {
    ...actual,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(
      async (input: { target?: AdapterExecutionTarget | null; env: NodeJS.ProcessEnv }) => {
        record(input.target, input.env);
      },
    ),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(
      async (_command: string, target: AdapterExecutionTarget | null | undefined, _cwd: string, env: NodeJS.ProcessEnv) => {
        record(target, env);
        throw setup.stop;
      },
    ),
  };
});
import { execute as claudeExecute, testEnvironment as claudeTest } from "@paperclipai/adapter-claude-local/server";
import { execute as codexExecute, testEnvironment as codexTest } from "@paperclipai/adapter-codex-local/server";
import { execute as cursorExecute, testEnvironment as cursorTest } from "@paperclipai/adapter-cursor-local/server";
import { execute as geminiExecute, testEnvironment as geminiTest } from "@paperclipai/adapter-gemini-local/server";
import { execute as grokExecute, testEnvironment as grokTest } from "@paperclipai/adapter-grok-local/server";
import { execute as kimiExecute, testEnvironment as kimiTest } from "@paperclipai/adapter-kimi-local/server";
import { execute as opencodeExecute, testEnvironment as opencodeTest } from "@paperclipai/adapter-opencode-local/server";
import { execute as piExecute, testEnvironment as piTest } from "@paperclipai/adapter-pi-local/server";
import { resolveClaudeExecutionEngineForRun, testClaudeAcpEnvironment } from "../../../packages/adapters/claude-local/src/server/acp.js";
import { resolveCodexExecutionEngineForRun, testCodexAcpEnvironment } from "../../../packages/adapters/codex-local/src/server/acp.js";
import { resolveGeminiExecutionEngineForRun, testGeminiAcpEnvironment } from "../../../packages/adapters/gemini-local/src/server/acp.js";
import { resolveKimiExecutionEngineForRun, testKimiAcpEnvironment } from "../../../packages/adapters/kimi-local/src/server/acp.js";

const SERVER_SECRET_KEY = "SANDBOX_CALL_SITE_SERVER_ONLY";

const ADAPTERS = [
  ["claude_local", claudeExecute, claudeTest],
  ["codex_local", codexExecute, codexTest],
  ["cursor", cursorExecute, cursorTest],
  ["gemini_local", geminiExecute, geminiTest],
  ["grok_local", grokExecute, grokTest],
  ["kimi_local", kimiExecute, kimiTest],
  ["opencode_local", opencodeExecute, opencodeTest],
  ["pi_local", piExecute, piTest],
] as const;

const ACP_ENGINES = [
  ["claude", resolveClaudeExecutionEngineForRun, "claude-agent-acp"],
  ["codex", resolveCodexExecutionEngineForRun, "codex-acp"],
  ["gemini", resolveGeminiExecutionEngineForRun, "gemini"],
  ["kimi", resolveKimiExecutionEngineForRun, "kimi"],
] as const;

const ACP_TESTS = [
  ["claude_local", testClaudeAcpEnvironment, "claude-agent-acp"],
  ["codex_local", testCodexAcpEnvironment, "codex-acp"],
  ["gemini_local", testGeminiAcpEnvironment, "gemini"],
  ["kimi_local", testKimiAcpEnvironment, "kimi"],
] as const;

describe("adapter setup call sites", () => {
  let root: string;
  let command: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-setup-call-sites-"));
    command = path.join(root, "agent");
    await fs.writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.HOME = root;
    process.env[SERVER_SECRET_KEY] = "server-only-value-canary";
    setup.calls.length = 0;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const sandboxTarget = (): AdapterExecutionTarget => ({
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    environmentId: "env-1",
    leaseId: "lease-1",
    remoteCwd: root,
    timeoutMs: 30_000,
    // Workspace sync and install checks run here, on this host.
    runner: {
      execute: async (input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string }) =>
        runChildProcess(`sandbox-exec-${Math.random()}`, input.command, input.args ?? [], {
          cwd: input.cwd ?? root,
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: 15,
          graceSec: 5,
          onLog: async () => {},
        }),
    },
  } as AdapterExecutionTarget);
  const sshTarget = (): AdapterExecutionTarget => ({
    kind: "remote",
    transport: "ssh",
    remoteCwd: root,
    spec: {
      host: "127.0.0.1",
      port: 22,
      username: "agent",
      privateKey: "PRIVATE KEY",
      knownHosts: "KNOWN HOSTS",
      remoteCwd: root,
      remoteWorkspacePath: root,
      strictHostKeyChecking: false,
    },
  } as AdapterExecutionTarget);

  const runExecute = (
    execute: (typeof ADAPTERS)[number][1],
    adapterType: string,
    executionTarget: AdapterExecutionTarget,
  ) => execute({
    runId: `run-${adapterType}`,
    agent: { id: "agent-1", companyId: "company-1", name: "Agent", adapterType, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      engine: "cli",
      command,
      cwd: root,
      model: "anthropic/claude-sonnet",
      env: { OPENAI_API_KEY: "sk-test-run-key" },
      promptTemplate: "hi",
    },
    context: {},
    runtimeCommandSpec: { command, detectCommand: "agent-runtime-detect", installCommand: "install-agent-runtime" },
    executionTarget,
    authToken: "run-jwt-token",
    onLog: async () => {},
  } as Parameters<typeof execute>[0]).catch((error: unknown) => {
    if (error !== setup.stop) throw error;
  });

  const runTest = (
    testEnvironment: (typeof ADAPTERS)[number][2],
    adapterType: string,
    executionTarget: AdapterExecutionTarget,
  ) => testEnvironment({
    companyId: "company-1",
    adapterType,
    config: { engine: "cli", command, cwd: root, model: "anthropic/claude-sonnet" },
    executionTarget,
  } as Parameters<typeof testEnvironment>[0]).catch(() => undefined);

  const hostEnvReached = (transport: string) =>
    setup.calls.filter((call) => call.transport === transport && SERVER_SECRET_KEY in call.env);

  it.each(ADAPTERS)("%s execute keeps the server env out of sandbox setup", async (adapterType, execute) => {
    await runExecute(execute, adapterType, sandboxTarget());

    expect(setup.calls.some((call) => call.transport === "sandbox")).toBe(true);
    expect(hostEnvReached("sandbox")).toEqual([]);
  }, 30_000);

  it.each(ADAPTERS)("%s testEnvironment keeps the server env out of the sandbox probe", async (adapterType, _execute, testEnvironment) => {
    await runTest(testEnvironment, adapterType, sandboxTarget());

    expect(setup.calls.some((call) => call.transport === "sandbox")).toBe(true);
    expect(hostEnvReached("sandbox")).toEqual([]);
  }, 30_000);

  it.each(ACP_ENGINES)("%s ACP probe keeps the server env out of the sandbox", async (_name, resolveEngine, agentCommand) => {
    await resolveEngine({
      config: { engine: "acp", agentCommand, acpAgentCommand: agentCommand, command: agentCommand, cwd: root },
      executionTarget: sandboxTarget(),
    });

    expect(setup.calls.some((call) => call.transport === "sandbox")).toBe(true);
    expect(hostEnvReached("sandbox")).toEqual([]);
  }, 30_000);

  // SSH resolves the local `ssh` binary, so its probe must keep the host PATH.
  // pi and opencode reach the SSH host before their probe, so they are not
  // covered here. ACP engine resolution rejects SSH targets before probing,
  // but the ACP environment test probes them.
  it.each(ADAPTERS.filter(([adapterType]) => adapterType !== "pi_local" && adapterType !== "opencode_local"))(
    "%s testEnvironment keeps the host PATH on the SSH probe",
    async (adapterType, _execute, testEnvironment) => {
      await runTest(testEnvironment, adapterType, sshTarget());

      const sshCalls = setup.calls.filter((call) => call.transport === "ssh");
      expect(sshCalls.length).toBeGreaterThan(0);
      expect(sshCalls.every((call) => call.env.PATH?.includes(savedEnv.PATH ?? "") ?? false)).toBe(true);
    },
    30_000,
  );

  it.each(ACP_TESTS)("%s ACP testEnvironment keeps the host PATH on the SSH probe", async (adapterType, testAcpEnvironment, agentCommand) => {
    await testAcpEnvironment({
      companyId: "company-1",
      adapterType,
      config: { engine: "acp", agentCommand, acpAgentCommand: agentCommand, command: agentCommand, cwd: root },
      executionTarget: sshTarget(),
    } as Parameters<typeof testAcpEnvironment>[0]).catch(() => undefined);

    const sshCalls = setup.calls.filter((call) => call.transport === "ssh");
    expect(sshCalls.length).toBeGreaterThan(0);
    expect(sshCalls.every((call) => call.env.PATH === savedEnv.PATH)).toBe(true);
  }, 30_000);
});
