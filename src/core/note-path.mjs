import path from 'node:path';

/** One lexical filename contract for settings, discovery and publication.
 * extname excludes bare .md/.markdown dotfiles; extension case folding is ASCII. */
export function isMarkdownPath(value, paths = path) {
  return typeof value === 'string' && /^\.(?:md|markdown)$/i.test(paths.extname(value));
}
