// Parsing and validation of .github/review-policy.yml.

import { parseYaml } from './yaml.mjs';
import { globToRegExp } from './glob.mjs';

export const CONFIG_PATH = '.github/review-policy.yml';
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ConfigError(`unknown key "${k}" in ${where}`);
  }
}

function stringList(v, where, { globs = false } = {}) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ConfigError(`${where} must be a list`);
  return v.map((s, i) => {
    if (typeof s !== 'string' || s === '') {
      throw new ConfigError(`${where}[${i}] must be a non-empty string`);
    }
    if (globs) {
      try {
        globToRegExp(s);
      } catch (err) {
        throw new ConfigError(`${where}[${i}]: ${err.message}`);
      }
    }
    return s;
  });
}

// validateConfig checks a parsed config object and returns a normalized
// copy. It throws ConfigError on anything unexpected, including unknown
// keys, so a typo cannot silently loosen the policy.
export function validateConfig(raw) {
  if (!isMap(raw)) throw new ConfigError('config must be a mapping');
  checkKeys(raw, ['version', 'bots', 'floor', 'never_auto_approve', 'tiers', 'experts'], 'config');
  if (raw.version !== 1) throw new ConfigError('version must be 1');

  const bots = stringList(raw.bots, 'bots');

  const floor = {};
  if (raw.floor !== undefined && raw.floor !== null) {
    if (!isMap(raw.floor)) throw new ConfigError('floor must be a mapping');
    checkKeys(raw.floor, SEVERITIES, 'floor');
    for (const sev of SEVERITIES) {
      floor[sev] = stringList(raw.floor[sev], `floor.${sev}`, { globs: true });
    }
  } else {
    for (const sev of SEVERITIES) floor[sev] = [];
  }

  const neverAutoApprove = stringList(raw.never_auto_approve, 'never_auto_approve', { globs: true });

  if (!isMap(raw.tiers)) throw new ConfigError('tiers must be a mapping');
  checkKeys(raw.tiers, SEVERITIES, 'tiers');
  const tiers = {};
  for (const sev of SEVERITIES) {
    const t = raw.tiers[sev];
    if (!isMap(t)) throw new ConfigError(`tiers.${sev} is required and must be a mapping`);
    checkKeys(t, ['humans', 'bot', 'fresh'], `tiers.${sev}`);
    if (!Number.isInteger(t.humans) || t.humans < 0) {
      throw new ConfigError(`tiers.${sev}.humans must be a non-negative integer`);
    }
    for (const flag of ['bot', 'fresh']) {
      if (t[flag] !== undefined && typeof t[flag] !== 'boolean') {
        throw new ConfigError(`tiers.${sev}.${flag} must be true or false`);
      }
    }
    tiers[sev] = { humans: t.humans, bot: t.bot === true, fresh: t.fresh === true };
  }

  const experts = {};
  if (raw.experts !== undefined && raw.experts !== null) {
    if (!isMap(raw.experts)) throw new ConfigError('experts must be a mapping');
    for (const [login, globs] of Object.entries(raw.experts)) {
      const key = login.toLowerCase();
      if (Object.hasOwn(experts, key)) throw new ConfigError(`duplicate expert "${login}"`);
      const list = stringList(globs, `experts.${login}`, { globs: true });
      if (list.length === 0) throw new ConfigError(`experts.${login} must list at least one glob`);
      experts[key] = list;
    }
  }

  return { version: 1, bots, floor, neverAutoApprove, tiers, experts };
}

export function parseConfig(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`cannot parse YAML: ${err.message}`);
  }
  return validateConfig(raw);
}
