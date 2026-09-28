import fs from 'node:fs';
import path from 'node:path';

export type JsonReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  /** The file could not be parsed and was renamed to `<name>.corrupt`. */
  | { status: 'corrupt' };

/**
 * Reads and parses a JSON file. A file that cannot be parsed is renamed to
 * `<name>.corrupt` (so it is not silently overwritten and can be recovered).
 */
export function readJsonFile(filePath: string): JsonReadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  try {
    return { status: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt`);
    } catch {
      // Keeping the unreadable file in place is acceptable; it is overwritten on the next save.
    }
    return { status: 'corrupt' };
  }
}

/** Writes JSON through a flushed temporary file and a rename, so a crash never leaves a half-written file. */
export function writeJsonFileAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${filePath}.tmp`;
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    // On Windows the rename can fail while another process (e.g. a virus scanner) holds the target open.
    fs.writeFileSync(filePath, json, 'utf8');
    fs.rmSync(tempPath, { force: true });
  }
}
