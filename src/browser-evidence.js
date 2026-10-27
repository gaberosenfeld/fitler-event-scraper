// These are the ONLY startup-error details allowed across the logging/API boundary.
// No raw text, paths, command lines, environment, page data or stack traces leave here.
export const EVIDENCE_VALUES = Object.freeze({
  errno: ['EACCES', 'EPERM', 'ENOENT'],
  components: ['sandbox_credentials', 'sandbox_namespace', 'sandbox_zygote', 'sandbox_setuid', 'process_singleton', 'crashpad', 'executable_spawn', 'shared_library_loader'],
  signatures: ['sandbox_credentials_permission_failure', 'namespace_permission_failure', 'no_usable_sandbox', 'root_without_sandbox', 'setuid_sandbox_failure', 'executable_spawn_permission_denied', 'browser_executable_missing', 'shared_library_missing', 'singleton_socket_permission_denied', 'crashpad_permission_failure', 'unspecified_permission_denied'],
  signals: ['SIGTRAP', 'SIGABRT', 'SIGKILL', 'SIGSEGV']
});

export function sanitizeBrowserEvidence(value) {
  const result = {};
  for (const [key, allowed] of Object.entries(EVIDENCE_VALUES)) {
    const entries = Array.isArray(value?.[key]) ? value[key] : [];
    result[key] = allowed.filter(item => entries.includes(item));
  }
  return result;
}

export function browserEvidenceSummary(value) {
  const safe = sanitizeBrowserEvidence(value);
  return `Startup evidence: ${safe.signatures.join(', ') || 'no_recognized_signature'}; errno=${safe.errno.join(',') || 'unknown'}; component=${safe.components.join(',') || 'unknown'}; signal=${safe.signals.join(',') || 'unknown'}.`;
}

export function browserEvidence(error) {
  // Playwright normally embeds child stderr in Error.message. Some wrappers put
  // it in .stderr or .cause; inspect only those strings, with strict size/depth caps.
  const fragments = []; const codes = []; const syscalls = []; const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    for (const key of ['message', 'stderr']) if (typeof current[key] === 'string') fragments.push(current[key].slice(0, 65536));
    if (typeof current.code === 'string') codes.push(current.code);
    if (typeof current.syscall === 'string') syscalls.push(current.syscall);
    current = current.cause;
  }
  const text = fragments.join('\n');
  const errno = [];
  if (codes.includes('EACCES') || /\bEACCES\b|Permission denied(?:\s*\(13\))?/i.test(text)) errno.push('EACCES');
  if (codes.includes('EPERM') || /\bEPERM\b|Operation not permitted(?:\s*\(1\))?/i.test(text)) errno.push('EPERM');
  if (codes.includes('ENOENT') || /\bENOENT\b|No such file or directory/i.test(text)) errno.push('ENOENT');
  const permissionDenied = errno.includes('EACCES') || errno.includes('EPERM');
  const components = [];
  const has = (pattern, component) => { const found = pattern.test(text); if (found) components.push(component); return found; };
  const credentials = has(/sandbox[\\/]linux[\\/]services[\\/]credentials\.cc/i, 'sandbox_credentials');
  const namespace = has(/namespace_sandbox\.cc/i, 'sandbox_namespace');
  has(/zygote_host_impl_linux\.cc/i, 'sandbox_zygote');
  const setuid = has(/SUID sandbox|setuid sandbox|chrome-sandbox/i, 'sandbox_setuid');
  const singleton = has(/process_singleton_posix\.cc/i, 'process_singleton');
  const crashpad = has(/chrome_crashpad_handler|crashpad/i, 'crashpad');
  const spawn = syscalls.some(value => /^spawn(?:\s|$)/.test(value)) || /\bspawn\b[^\n]*(?:EACCES|EPERM|ENOENT)/i.test(text);
  if (spawn) components.push('executable_spawn');
  const libraries = has(/error while loading shared libraries|Host system is missing dependencies|cannot open shared object file/i, 'shared_library_loader');
  const signatures = [];
  if (credentials && permissionDenied) signatures.push('sandbox_credentials_permission_failure');
  if ((namespace || /Failed to move to new namespace|(?:create|creating|setup|unshare|clone)[^\n]{0,120}(?:user )?namespace/i.test(text)) && permissionDenied) signatures.push('namespace_permission_failure');
  if (/No usable sandbox/i.test(text)) signatures.push('no_usable_sandbox');
  if (/Running as root without --no-sandbox/i.test(text)) signatures.push('root_without_sandbox');
  if (setuid && /not configured correctly|failed|Permission denied|Operation not permitted/i.test(text)) signatures.push('setuid_sandbox_failure');
  if (spawn && permissionDenied) signatures.push('executable_spawn_permission_denied');
  if (/Executable doesn't exist|executable[^\n]*(?:not found|does not exist)/i.test(text) || (spawn && errno.includes('ENOENT'))) signatures.push('browser_executable_missing');
  if (libraries) signatures.push('shared_library_missing');
  if (singleton && /socket\(\)[^\n]*(?:Permission denied|Operation not permitted)/i.test(text)) signatures.push('singleton_socket_permission_denied');
  if (crashpad && permissionDenied) signatures.push('crashpad_permission_failure');
  if (permissionDenied && signatures.length === 0) signatures.push('unspecified_permission_denied');
  const signals = EVIDENCE_VALUES.signals.filter(signal => new RegExp(`\\b${signal}\\b`).test(text));
  return sanitizeBrowserEvidence({ errno, components, signatures, signals });
}
