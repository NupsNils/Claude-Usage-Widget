// Detection of Anthropic secrets (session keys, API / OAuth / admin tokens) in
// text that a Write / Edit / MultiEdit / NotebookEdit tool call is about to write.

/**
 * Anthropic credential shape: "sk-ant-" + kind + two-digit version + "-" + a
 * long base64url body, e.g. sid01 (claude.ai session key), api03, oat01, ort01,
 * admin01. The 20 character minimum keeps placeholders such as
 * "sk-ant-sid01-..." and prefix checks such as startsWith('sk-ant-') out.
 */
export const SECRET_PATTERN = /sk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{20,}/g;

/** Number of leading characters of a secret that may be shown in messages. */
export const MASK_VISIBLE_CHARS = 12;

/**
 * Collects every piece of text a file-writing tool call is about to write.
 *
 * @param {unknown} toolInput  The `tool_input` object from the hook payload.
 * @returns {{ field: string, text: string }[]}
 */
export function collectWrittenText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return [];
  }
  /** @type {Record<string, any>} */
  const input = toolInput;
  const pieces = [];
  for (const field of ['content', 'new_string', 'new_source']) {
    if (typeof input[field] === 'string') {
      pieces.push({ field, text: input[field] });
    }
  }
  if (Array.isArray(input.edits)) {
    input.edits.forEach((edit, index) => {
      if (edit && typeof edit === 'object' && typeof edit.new_string === 'string') {
        pieces.push({ field: `edits[${index}].new_string`, text: edit.new_string });
      }
    });
  }
  return pieces;
}

/**
 * Returns true for placeholder-looking tokens that should not count as secrets.
 * A body made only of "x" characters ("sk-ant-api03-xxxxxxxx...") is a common
 * documentation placeholder and can never be a real credential.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
export function isObviousPlaceholder(candidate) {
  const body = candidate.slice(candidate.lastIndexOf('-') + 1);
  return /^[xX]+$/.test(body);
}

/**
 * Finds all distinct secret-looking tokens in a text.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text.includes('sk-ant-')) {
    return [];
  }
  const found = new Set();
  for (const match of text.matchAll(SECRET_PATTERN)) {
    if (!isObviousPlaceholder(match[0])) {
      found.add(match[0]);
    }
  }
  return [...found];
}

/**
 * Masks a secret so it can be mentioned in a message without leaking it.
 *
 * @param {string} secret
 * @returns {string}
 */
export function maskSecret(secret) {
  const value = String(secret ?? '');
  return `${value.slice(0, MASK_VISIBLE_CHARS)}... (${value.length} chars)`;
}

/**
 * Decides whether a PreToolUse call must be blocked.
 *
 * @param {Record<string, any> | null} input  Parsed hook payload.
 * @returns {{ block: false } | { block: true, message: string, findings: { field: string, masked: string }[] }}
 */
export function evaluateSecretGuard(input) {
  if (!input || typeof input !== 'object') {
    return { block: false };
  }
  const toolInput = input.tool_input;
  const findings = [];
  const seen = new Set();
  for (const { field, text } of collectWrittenText(toolInput)) {
    for (const secret of findSecrets(text)) {
      if (seen.has(secret)) continue;
      seen.add(secret);
      findings.push({ field, masked: maskSecret(secret) });
    }
  }
  if (findings.length === 0) {
    return { block: false };
  }
  const target =
    (toolInput && (toolInput.file_path || toolInput.notebook_path)) || 'the target file';
  const lines = [
    `Blocked by .claude/hooks/secret-guard.mjs: the ${input.tool_name || 'write'} to ${target} contains ` +
      `${findings.length === 1 ? 'what looks like a real Anthropic secret' : `${findings.length} values that look like real Anthropic secrets`}:`,
    ...findings.map((finding) => `  - ${finding.masked} in tool_input.${finding.field}`),
    'Never write session keys or API / OAuth tokens into project files. Load them at runtime from secure storage',
    "(for example Electron safeStorage) or an environment variable, and use a short placeholder such as 'sk-ant-sid01-...'",
    'in code, tests and docs. In tests, assemble fake keys at runtime instead of writing them literally.',
  ];
  return { block: true, message: lines.join('\n'), findings };
}
