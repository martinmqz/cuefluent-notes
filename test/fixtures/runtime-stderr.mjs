/** Keep failures and unexpected diagnostics visible while tolerating Node's
 * one-time notice for the native macOS ACL API. Production warnings stay on. */
export function withoutFfiNotice(stderr, pid) {
  if (process.platform !== 'darwin') return stderr;
  const notice = `(node:${pid}) ExperimentalWarning: FFI is an experimental feature and might change at any time\n` +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  return stderr.replace(notice, '');
}
