// Lowercase names are creation defaults; existing case variants keep their spelling.
export const NOTE_CATEGORIES = Object.freeze(['meetings', 'tasks', 'knowledge-base', 'decisions']);
export const isNoteCategory = name => typeof name === 'string' && NOTE_CATEGORIES.includes(name.toLowerCase());
