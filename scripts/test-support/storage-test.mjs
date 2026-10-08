import './isolated-settings.mjs';
import test from 'node:test';
import { withStorageProbes } from '../storage-platform.mjs';

// Exercise the same scoped native checks as a CLI operation: fresh Windows ACL
// queries and stat-versioned macOS ACL reuse, with fresh locality checks.
// Native standalone/Restricted-policy tests deliberately use node:test directly.
export default function storageTest(name, options, operation) {
  if (typeof options === 'function') { operation = options; options = {}; }
  return test(name, options, t => withStorageProbes(() => operation(t)));
}
