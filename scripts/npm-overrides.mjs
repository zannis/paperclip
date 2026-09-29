/**
 * The published CLI is installed with npm, which never reads the workspace's
 * pnpm overrides. A nested pnpm override (`parent@version>child`) pins a
 * provider runtime (the Claude Agent SDK under claude-agent-acp, Codex under
 * codex-acp), so each one is carried into npm's `overrides`. Top-level pnpm
 * overrides only dedupe workspace-only packages and are left out.
 */
export function npmOverridesFrom(pnpmOverrides) {
  const out = {};
  for (const [selector, version] of Object.entries(pnpmOverrides ?? {})) {
    const at = selector.indexOf(">");
    if (at === -1) continue;
    const parent = selector.slice(0, at);
    const child = selector.slice(at + 1);
    if (!parent || !child || child.includes(">")) {
      throw new Error(`pnpm override ${selector} has no npm equivalent`);
    }
    out[parent] = { ...(out[parent] ?? {}), [child]: version };
  }
  return out;
}
