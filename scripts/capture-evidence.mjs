import { MAX_TOOL_BYTES, MAX_CAPTURE_TOOL_BYTES } from './capture-contract.mjs';
import { string } from './workflow-values.mjs';

const serializedLimit = 1024 * 1024;
export function clipUTF8(value, limit) {
  string(value, 64 * 1024 * 1024, { empty: true });
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value, omitted: 0 };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), omitted: bytes.length - end };
}
export function evidenceCollector(previous = { evidence: [], omissions: [] }) {
  const evidence = structuredClone(previous.evidence), omissions = structuredClone(previous.omissions);
  let tools = evidence.filter(item => item.kind.startsWith('tool-')).reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
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
    if (evidence.length >= 2048 || serializedBytes >= serializedLimit - 2048) { omit('evidence-budget-exhausted', record); return; }
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
    const isTool = kind.startsWith('tool-');
    if (typeof value.text === 'string' && value.text.includes('\0')) {
      omit('control-characters-replaced', record, { bytes: value.text.split('\0').length - 1 });
      value = { ...value, text: value.text.replaceAll('\0', '\ufffd') };
    }
    if (isTool && tools >= MAX_CAPTURE_TOOL_BYTES) { omit('tool-budget-exhausted', record, { bytes: Buffer.byteLength(value.text) }); return; }
    const remaining = isTool ? Math.min(MAX_TOOL_BYTES, MAX_CAPTURE_TOOL_BYTES - tools) : serializedLimit;
    let clipped = clipUTF8(value.text, remaining);
    // JSON escaping and per-item provenance count against the same serialized budget.
    let low = 0, high = Buffer.byteLength(clipped.text);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), trial = clipUTF8(clipped.text, mid).text;
      if (serializedBytes + Buffer.byteLength(JSON.stringify({ ...base, ...value, text: trial })) <= serializedLimit - 2048) low = mid;
      else high = mid - 1;
    }
    clipped = clipUTF8(value.text, low);
    if (clipped.omitted) omit(isTool ? 'tool-excerpt-truncated' : 'text-truncated', record, { bytes: clipped.omitted });
    if (isTool) tools += Buffer.byteLength(clipped.text);
    // An observed empty result is still evidence; omitted user content is not invented text.
    if (clipped.text || (isTool && !clipped.omitted)) {
      const item = { ...base, ...value, text: clipped.text };
      evidence.push(item); serializedBytes += Buffer.byteLength(JSON.stringify(item));
    }
  };
  return { evidence, omissions, omit, add };
}
