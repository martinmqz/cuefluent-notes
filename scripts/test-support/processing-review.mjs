// Emulate a host submitting an unchanged form, while allowing tests to supply
// edited or missing preview values explicitly.
export function withReviewPreview(form, result) {
  return result.action === 'accept' && result.content && form.params.requestedSchema.properties.changes
    ? { ...result, content: { changes: form.params.requestedSchema.properties.changes.default, ...result.content } }
    : result;
}
