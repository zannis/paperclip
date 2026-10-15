import type { Environment, SandboxEnvironmentConfig } from "@paperclipai/shared";

/** Resolve runner retention before acquiring a sandbox, not after it is ephemeral.
 * This is a run-scoped view; never persist it over a shared environment's config.
 * The driver still verifies provider support and chooses the actual lease policy.
 */
export function resolveRunnerEnvironmentForRun<T extends Pick<Environment, "driver" | "config">>(
  environment: T,
  adapterType: string,
  adapterConfig: Record<string, unknown> = {},
  admittedLifecycleMode?: "warm" | "per_turn",
): T {
  if (adapterType !== "paperclip_runner" || environment.driver !== "sandbox") return environment;
  const config = environment.config ?? {};
  const lifecycleMode = admittedLifecycleMode ?? (config.runnerLifecycleMode === "warm" || config.runnerLifecycleMode === "per_turn"
    ? config.runnerLifecycleMode
    : adapterConfig.lifecycleMode);
  if (lifecycleMode !== "warm") return environment;
  return {
    ...environment,
    config: {
      ...config,
      reuseLease: true,
    },
  };
}

export const DEFAULT_WARM_RUNNER_IDLE_TIMEOUT_MS = 300_000;

// A warm sandbox environment keeps its runner and its provider sandbox between
// turns. `runnerIdleTimeoutMs` bounds both: the runner session inside the
// sandbox, and the retained sandbox itself. A sandbox environment that is not
// warm has no idle timeout.
export function warmRunnerIdleTimeoutMs(
  config: Pick<SandboxEnvironmentConfig, "runnerLifecycleMode" | "runnerIdleTimeoutMs">,
): number | null {
  if (config.runnerLifecycleMode !== "warm") return null;
  return typeof config.runnerIdleTimeoutMs === "number"
    ? config.runnerIdleTimeoutMs
    : DEFAULT_WARM_RUNNER_IDLE_TIMEOUT_MS;
}
