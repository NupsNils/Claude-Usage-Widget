// Parsing of `git status --porcelain` (v1) output and filtering of the changed
// paths that should trigger the Stop test gate.

/** Directories (repository-relative, forward slashes) that contain gated sources. */
export const SOURCE_DIRS = ['src/', '.claude/hooks/', 'scripts/'];

/** File extensions that count as source files for the test gate. */
export const SOURCE_EXTENSIONS = ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'html', 'css', 'json'];

const SOURCE_EXTENSION_PATTERN = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`, 'i');

const SIMPLE_ESCAPES = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c };

/**
 * Decodes a path that git printed as a C-style quoted string, including octal
 * escapes for non-ASCII UTF-8 bytes ("src/\303\244.ts" -> "src/ä.ts").
 * Unquoted input is returned unchanged.
 *
 * @param {string} value
 * @returns {string}
 */
export function unquoteGitPath(value) {
  if (typeof value !== 'string' || value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  const inner = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = inner[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))[0];
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
    } else if (next !== undefined && Object.hasOwn(SIMPLE_ESCAPES, next)) {
      bytes.push(SIMPLE_ESCAPES[next]);
      i += 1;
    } else {
      bytes.push(0x5c);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Splits the path part of a porcelain line into one or two paths. Rename and
 * copy entries have the form `old -> new`, where each side may be quoted.
 *
 * @param {string} rest
 * @returns {string[]}
 */
function splitPaths(rest) {
  const paths = [];
  let remaining = rest;
  while (remaining.length > 0) {
    let token;
    if (remaining.startsWith('"')) {
      // Find the closing quote that is not escaped.
      let end = 1;
      while (end < remaining.length) {
        if (remaining[end] === '\\') {
          end += 2;
          continue;
        }
        if (remaining[end] === '"') break;
        end += 1;
      }
      token = remaining.slice(0, end + 1);
      remaining = remaining.slice(end + 1);
    } else {
      const arrow = remaining.indexOf(' -> ');
      token = arrow === -1 ? remaining : remaining.slice(0, arrow);
      remaining = arrow === -1 ? '' : remaining.slice(arrow);
    }
    paths.push(unquoteGitPath(token));
    if (remaining.startsWith(' -> ')) {
      remaining = remaining.slice(4);
    } else {
      break;
    }
  }
  return paths;
}

/**
 * Parses `git status --porcelain` (v1, without -z) output into a flat list of
 * repository-relative paths. For renames and copies both the old and the new
 * path are returned, since removing a source file is a source change too.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function parsePorcelain(output) {
  if (typeof output !== 'string') {
    return [];
  }
  const paths = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    // "XY path": two status characters, a space, then the path(s).
    // Branch header lines ("## main") only appear with --branch; skip them.
    if (line.length < 4 || line[2] !== ' ' || line.startsWith('## ')) {
      continue;
    }
    for (const entry of splitPaths(line.slice(3))) {
      if (entry) paths.push(entry);
    }
  }
  return paths;
}

/**
 * True for repository-relative paths that should trigger the test gate.
 * Directory entries (trailing slash, printed for untracked folders without
 * --untracked-files=all) count when they overlap a source directory.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSourcePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.endsWith('/')) {
    return SOURCE_DIRS.some((dir) => normalized.startsWith(dir) || dir.startsWith(normalized));
  }
  return SOURCE_DIRS.some((dir) => normalized.startsWith(dir)) && SOURCE_EXTENSION_PATTERN.test(normalized);
}

/**
 * Returns the distinct changed paths that match the source patterns.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
export function filterSourceChanges(paths) {
  return [...new Set((paths || []).filter(isSourcePath))];
}
