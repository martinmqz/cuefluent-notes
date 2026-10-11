import { MAX_TOOL_BYTES, MAX_CAPTURE_TOOL_BYTES } from './capture-contract.mjs';
import { string, choice } from './workflow-values.mjs';

const serializedLimit = 1024 * 1024;
// Text allowances only. Native descriptors still share the serialized/record
// envelope; they do not establish task success or guarantee lossless retention.
const toolBudgets = {
  'tool-call': { total: 64 * 1024, perCall: 8 * 1024 },
  'tool-result': { total: 192 * 1024, perCall: 16 * 1024 }
};
export function clipUTF8(value, limit) {
  string(value, 64 * 1024 * 1024, { empty: true });
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value, omitted: 0 };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), omitted: bytes.length - end };
}
export function evidenceCollector(previous = { evidence: [], omissions: [] }, { toolRulesVersion = '2' } = {}) {
  choice(toolRulesVersion, ['1', '2']);
  const legacy = toolRulesVersion === '1';
  const evidence = structuredClone(previous.evidence), omissions = structuredClone(previous.omissions);
  let emptyDescriptors = omissions.filter(item => item.reason === 'tool-text-omitted').length;
  let tools = evidence.filter(item => item.kind.startsWith('tool-')).reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
  const kindBytes = { 'tool-call': 0, 'tool-result': 0 }, callBytes = new Map();
  const account = (kind, callId, bytes) => {
    kindBytes[kind] += bytes;
    const key = `${kind}:${callId}`; callBytes.set(key, (callBytes.get(key) ?? 0) + bytes);
  };
  for (const item of evidence) if (Object.hasOwn(toolBudgets, item.kind)) account(item.kind, item.callId, Buffer.byteLength(item.text));
  let serializedBytes = evidence.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
  const sanitizeCaption = (record, caption) => {
    if (caption.includes('\0')) omit('control-characters-replaced', record, { bytes: caption.split('\0').length - 1 });
    const clipped = clipUTF8(caption.replaceAll('\0', '\ufffd'), 512);
    if (clipped.omitted) omit('attachment-caption-truncated', record, { bytes: clipped.omitted });
    return clipped.text;
  };
  const omit = (reason, record, details = {}) => {
    if (typeof details.caption === 'string') details = { ...details, caption: sanitizeCaption(record, details.caption) };
    const existing = omissions.find(item => item.reason === reason && item.mimeType === details.mimeType);
    if (existing) { existing.count = (existing.count ?? 1) + 1; if (details.bytes) existing.bytes = (existing.bytes ?? 0) + details.bytes; return; }
    if (omissions.length >= 63) {
      if (omissions.length === 63) omissions.push({ reason: 'additional-omissions-combined', recordId: record.id, bytes: details.bytes ?? 0 });
      else { omissions[63].bytes += details.bytes ?? 0; omissions[63].count = (omissions[63].count ?? 1) + 1; }
      return;
    }
    omissions.push({ reason, recordId: record.id, ...details });
  };
  const add = (kind, record, value) => {
    const isTool = Object.hasOwn(toolBudgets, kind);
    // Validate v2 tool payloads even when no evidence capacity remains. NUL
    // replacement still happens below; shape/Unicode failures are coded errors.
    if (isTool && !legacy) string(typeof value.text === 'string' ? value.text.replaceAll('\0', '\ufffd') : value.text, 64 * 1024 * 1024, { empty: true });
    if (evidence.length >= 2048 || serializedBytes >= serializedLimit - 2048) {
      omit(isTool && !legacy ? (evidence.length >= 2048 ? 'tool-evidence-record-limit' : 'tool-evidence-serialized-limit') : 'evidence-budget-exhausted', record,
        isTool && !legacy ? { bytes: Buffer.byteLength(value.text) } : {}); return;
    }
    const base = { kind, recordId: record.id, range: { startByte: record.startByte, endByte: record.endByte, recordIds: [record.id] } };
    if (kind === 'attachment') {
      const reference = value.reference;
      if (typeof reference !== 'string') { omit('attachment-without-reusable-reference', record); return; }
      if (/^data:/i.test(reference)) {
        const mime = /^data:([^;,]{1,128})[,;]/i.exec(reference)?.[1];
        omit('inline-attachment-not-copied', record, { ...(mime ? { mimeType: mime } : {}), ...(value.caption ? { caption: value.caption } : {}) }); return;
      }
      if (/^(?:javascript|vbscript):/i.test(reference.trim()) || /[\x00-\x1f\x7f]/.test(reference) || reference.length > 8192) {
        omit('unsupported-attachment-reference', record); return;
      }
      if (typeof value.caption === 'string') value = { ...value, caption: sanitizeCaption(record, value.caption) };
      const item = { ...base, ...value }, bytes = Buffer.byteLength(JSON.stringify(item));
      if (serializedBytes + bytes > serializedLimit) { omit('evidence-budget-exhausted', record); return; }
      evidence.push(item); serializedBytes += bytes; return;
    }
    if (typeof value.text === 'string' && value.text.includes('\0')) {
      omit('control-characters-replaced', record, { bytes: value.text.split('\0').length - 1 });
      value = { ...value, text: value.text.replaceAll('\0', '\ufffd') };
    }
    if (isTool && legacy && tools >= MAX_CAPTURE_TOOL_BYTES) { omit('tool-budget-exhausted', record, { bytes: Buffer.byteLength(value.text) }); return; }
    const limit = isTool && !legacy ? [
      { bytes: toolBudgets[kind].perCall - (callBytes.get(`${kind}:${value.callId}`) ?? 0), reason: `${kind}-call-limit` },
      { bytes: toolBudgets[kind].total - kindBytes[kind], reason: `${kind}-budget-exhausted` },
      // Older retained evidence may exceed one v2 kind's allocation. Preserve
      // those bytes without admitting new text above the shared format ceiling.
      { bytes: MAX_CAPTURE_TOOL_BYTES - tools, reason: 'tool-budget-exhausted' }
    ].sort((a, b) => a.bytes - b.bytes)[0] : { bytes: isTool ? Math.min(MAX_TOOL_BYTES, MAX_CAPTURE_TOOL_BYTES - tools) : serializedLimit, reason: 'text-truncated' };
    let clipped = clipUTF8(value.text, Math.max(0, limit.bytes));
    if (isTool && !legacy && clipped.omitted) omit(limit.reason, record, { bytes: clipped.omitted });
    // JSON escaping and per-item provenance count against the same serialized budget.
    let low = 0, high = Buffer.byteLength(clipped.text);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), trial = clipUTF8(clipped.text, mid).text;
      if (serializedBytes + Buffer.byteLength(JSON.stringify({ ...base, ...value, text: trial })) <= serializedLimit - 2048) low = mid;
      else high = mid - 1;
    }
    clipped = clipUTF8(isTool && !legacy ? clipped.text : value.text, low);
    const sizeLossReported = isTool && !legacy && clipped.omitted > 0;
    if (clipped.omitted) omit(isTool ? (legacy ? 'tool-excerpt-truncated' : 'tool-evidence-serialized-limit') : 'text-truncated', record, { bytes: clipped.omitted });
    // Retain native descriptors when only text allowance is exhausted. Omission
    // metadata distinguishes a clipped-to-empty result from an observed empty one.
    if (clipped.text || (isTool && (!legacy || !clipped.omitted))) {
      const item = { ...base, ...value, text: clipped.text };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (!legacy && serializedBytes + size > serializedLimit - 2048) {
        if (!sizeLossReported) omit(isTool ? 'tool-evidence-serialized-limit' : 'evidence-budget-exhausted', record, { bytes: Buffer.byteLength(clipped.text) }); return;
      }
      if (isTool && !legacy && !clipped.text && value.text) {
        // A bounded, unaggregated record marker makes clipped-to-empty different
        // from genuinely empty output. Do not fill the envelope with descriptors.
        if (emptyDescriptors >= 32 || evidence.length >= 2016 || omissions.length >= 62) {
          omit('tool-descriptor-budget-exhausted', record); return;
        }
        omissions.push({ reason: 'tool-text-omitted', recordId: record.id }); emptyDescriptors++;
      }
      evidence.push(item); serializedBytes += size;
      if (isTool) { const bytes = Buffer.byteLength(clipped.text); tools += bytes; account(kind, value.callId, bytes); }
    }
  };
  return { evidence, omissions, omit, add };
}
