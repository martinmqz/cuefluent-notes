import { descriptor, boundedText, executablePath, privateCwd, requireClient } from './protocol.mjs';
import { runClaude } from './claude.mjs';
import { runCodex } from './codex.mjs';
import { PACKAGE_VERSION_PATTERN } from '../../core/version.mjs';

/** Worker-owned native session. The MCP executable/arguments are trusted
 * application configuration; neither model output nor source input chooses them.
 * Completion has no elapsed timeout. signal is only for explicit cancellation
 * or loss of worker ownership. This adapter never reads authentication files. */
export async function runDraftingSession(options, dependencies = {}) {
  requireClient(options && ['claude', 'codex'].includes(options.client), 'PROCESSING_ARGUMENT');
  requireClient(!options.signal?.aborted, 'PROCESSING_ABORTED');
  requireClient(typeof options.version === 'string' && PACKAGE_VERSION_PATTERN.test(options.version), 'PROCESSING_ARGUMENT');
  // A native provider may use deployment-specific model names. Omission keeps
  // Codex's configured model; an explicit trusted host selection remains valid.
  const model = options.model ?? (options.client === 'codex' ? undefined : 'opus'), effort = options.effort ?? 'high';
  requireClient(options.client === 'codex' ? model === undefined || boundedText(model, 256) && model.length > 0 && !/\s|\p{Cc}/u.test(model) : ['opus', 'claude-opus-5-5'].includes(model), 'PROCESSING_ARGUMENT');
  requireClient(['high', 'xhigh'].includes(effort), 'PROCESSING_ARGUMENT');
  requireClient(boundedText(options.prompt, 64 * 1024) && options.prompt.trim() && boundedText(options.input, 4 * 1024 * 1024), 'PROCESSING_ARGUMENT');
  requireClient(options.onStarted === undefined || typeof options.onStarted === 'function', 'PROCESSING_ARGUMENT');
  const mcp = descriptor(options.mcp), cwd = await privateCwd(options.cwd), executable = await executablePath(options.executable ?? options.client);
  const normalized = { ...options, mcp, cwd, executable, model, effort };
  try { return await (options.client === 'codex' ? runCodex(normalized, dependencies) : runClaude(normalized, dependencies)); }
  catch (error) { requireClient(!options.signal?.aborted, 'PROCESSING_ABORTED'); throw error; }
}
