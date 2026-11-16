import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// The parameters (index persons, windows, medication sets, …) are generated once into a JSON file and read by
// both engines. Its SHA-256 is written into every result file, so two runs are comparable only if the hashes match.

export interface LoadedParams {
  file: string | null;
  sha256: string;
  data: unknown;
}

export const sha256 = (buf: string | Buffer) => createHash('sha256').update(buf).digest('hex');

export function loadParams(file: string | null): LoadedParams {
  if (!file) return { file: null, sha256: sha256('{}'), data: {} };
  const raw = readFileSync(file);
  return { file, sha256: sha256(raw), data: JSON.parse(raw.toString('utf8')) as unknown };
}
