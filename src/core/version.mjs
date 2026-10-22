import { fail } from './errors.mjs';

export const PACKAGE_NAME = 'cuefluent-notes';
// Exact SemVer core with an optional prerelease. Build metadata is excluded:
// tags, archive names, manifests and protocol identities all carry this exact
// string, so each release needs one portable, unique spelling. The product's
// public version line is independent of internal rewrite names.
export const PACKAGE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export function packageVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || !PACKAGE_VERSION_PATTERN.test(value)) fail('PACKAGE_INVALID', 'The package version is invalid.');
  return value;
}

/** The source manifest is trusted application configuration; only its identity is checked here. */
export function packageIdentity(manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.name !== PACKAGE_NAME) fail('PACKAGE_INVALID', 'The package identity is invalid.');
  return packageVersion(manifest.version);
}
