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

/**
 * npm refuses (EOVERRIDE) an override keyed on a package the manifest also
 * depends on directly unless that dependency is pinned to the override's exact
 * version, so a range there fails the managed install on the box.
 */
export function assertOverridesMatchDirectPins(overrides, dependencies) {
  for (const key of Object.keys(overrides)) {
    const at = key.lastIndexOf("@");
    const [name, version] = at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, null];
    const spec = dependencies[name];
    if (spec === undefined || version === null) continue;
    if (spec !== version) {
      throw new Error(`npm override ${key} needs the direct dependency ${name} pinned to ${version}, not ${spec}`);
    }
  }
}
