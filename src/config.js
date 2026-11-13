// Where the CLI keeps the API key: one JSON file only the user can read (0600 in a 0700 folder).
// Lookup order for the key: --key, then PROXY302_API_KEY, then this file.

import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(env = process.env) {
  if (env.PROXY302_CONFIG_DIR) return env.PROXY302_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'proxy302');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'proxy302');
}

export const configFile = (env = process.env) => join(configDir(env), 'config.json');

export function readConfig(env = process.env) {
  try {
    const value = JSON.parse(fs.readFileSync(configFile(env), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Writes atomically with owner-only permissions; returns the file path. */
export function writeConfig(config, env = process.env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this file system */ }
  return file;
}

/** @returns {{key?: string, source: string|null, baseUrl?: string}} */
export function resolveKey(flags = {}, env = process.env) {
  const config = readConfig(env);
  const baseUrl = flags['base-url'] || env.PROXY302_BASE_URL || config.base_url || undefined;
  if (flags.key) return { key: String(flags.key), source: '--key', baseUrl };
  if (env.PROXY302_API_KEY) return { key: env.PROXY302_API_KEY, source: 'PROXY302_API_KEY', baseUrl };
  if (config.api_key) return { key: String(config.api_key), source: configFile(env), baseUrl };
  return { key: undefined, source: null, baseUrl };
}
