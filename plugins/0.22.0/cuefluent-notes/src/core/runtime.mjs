// Shared policy, with no presentation, storage, or built-in dependencies.
export const NODE_REQUIREMENT = 'Node 26.12.1 or a later 26.x release';

export function supportsNode(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 26 && (minor > 12 || minor === 12 && patch >= 1);
}
