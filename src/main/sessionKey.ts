const SESSION_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{16,}$/;

/**
 * Cleans up a pasted claude.ai `sessionKey` cookie value. Accepts the bare value
 * or a copied `sessionKey=...;` pair, optionally in quotes. Returns null when the
 * input does not look like a session key.
 */
export function normalizeSessionKey(input: string): string | null {
  let value = input.trim();
  value = value.replace(/^sessionKey\s*=\s*/i, '');
  value = value.replace(/;\s*$/, '').trim();
  value = value.replace(/^(["'])(.*)\1$/, '$2').trim();
  return SESSION_KEY_PATTERN.test(value) ? value : null;
}
