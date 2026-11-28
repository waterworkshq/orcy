/**
 * Quote a value for a POSIX shell command line: single quotes keep every
 * character literal, and an embedded single quote is closed, escaped, reopened.
 */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Quote a word only when a shell would read it differently — paths with spaces, for instance. */
export const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : shellQuote(word);
