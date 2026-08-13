import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ReadImageError } from "./errors.js";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "./image-input.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} from "./openai.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".read-image-cli", "config.json");

const CONFIG_ALIASES = {
  apiKey: ["apiKey", "READ_IMAGE_API_KEY"],
  baseUrl: ["baseUrl", "READ_IMAGE_BASE_URL"],
  model: ["model", "READ_IMAGE_MODEL"],
  systemPrompt: ["systemPrompt"],
  appendPrompt: ["appendPrompt"],
  detail: ["detail", "READ_IMAGE_DETAIL"],
  maxTokens: ["maxTokens", "READ_IMAGE_MAX_TOKENS"],
  maxBytes: ["maxBytes", "READ_IMAGE_MAX_BYTES"],
  timeoutMs: ["timeoutMs", "READ_IMAGE_TIMEOUT_MS"],
  allowPrivateNetwork: ["allowPrivateNetwork", "READ_IMAGE_ALLOW_PRIVATE_NETWORK"],
};

const DEFAULTS = {
  apiKey: undefined,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  appendPrompt: undefined,
  detail: "auto",
  maxTokens: undefined,
  maxBytes: DEFAULT_MAX_IMAGE_BYTES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  allowPrivateNetwork: false,
};

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function pickValue(object, keys) {
  for (const key of keys) {
    if (hasOwn(object, key)) {
      return object[key];
    }
  }
  return undefined;
}

function normalizeConfigObject(object) {
  const result = {};
  for (const [field, aliases] of Object.entries(CONFIG_ALIASES)) {
    const value = pickValue(object, aliases);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function parsePositiveInteger(value, label) {
  if (!/^\d+$/.test(value)) {
    throw new ReadImageError("INVALID_CONFIG", `${label} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReadImageError("INVALID_CONFIG", `${label} must be a positive integer.`);
  }
  return parsed;
}

function parseBoolean(value, label) {
  if (typeof value === "boolean") {
    return value;
  }

  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) {
    return false;
  }

  throw new ReadImageError("INVALID_CONFIG", `${label} must be a boolean.`);
}

function readEnvironment(env) {
  const result = {};
  if (env.READ_IMAGE_API_KEY !== undefined) {
    result.apiKey = env.READ_IMAGE_API_KEY;
  }
  if (env.READ_IMAGE_BASE_URL) {
    result.baseUrl = env.READ_IMAGE_BASE_URL;
  }
  if (env.READ_IMAGE_MODEL) {
    result.model = env.READ_IMAGE_MODEL;
  }
  if (env.READ_IMAGE_DETAIL !== undefined) {
    result.detail = env.READ_IMAGE_DETAIL;
  }
  if (env.READ_IMAGE_MAX_TOKENS !== undefined) {
    result.maxTokens = parsePositiveInteger(env.READ_IMAGE_MAX_TOKENS, "READ_IMAGE_MAX_TOKENS");
  }
  if (env.READ_IMAGE_MAX_BYTES !== undefined) {
    result.maxBytes = parsePositiveInteger(env.READ_IMAGE_MAX_BYTES, "READ_IMAGE_MAX_BYTES");
  }
  if (env.READ_IMAGE_TIMEOUT_MS !== undefined) {
    result.timeoutMs = parsePositiveInteger(env.READ_IMAGE_TIMEOUT_MS, "READ_IMAGE_TIMEOUT_MS");
  }
  if (env.READ_IMAGE_ALLOW_PRIVATE_NETWORK !== undefined) {
    result.allowPrivateNetwork = parseBoolean(
      env.READ_IMAGE_ALLOW_PRIVATE_NETWORK,
      "READ_IMAGE_ALLOW_PRIVATE_NETWORK",
    );
  }
  return result;
}

function validateSettings(settings) {
  for (const field of ["apiKey", "baseUrl", "model", "systemPrompt", "appendPrompt"]) {
    if (settings[field] !== undefined && typeof settings[field] !== "string") {
      throw new ReadImageError("INVALID_CONFIG", `${field} must be a string.`);
    }
  }

  if (!["auto", "low", "high"].includes(settings.detail)) {
    throw new ReadImageError("INVALID_CONFIG", "detail must be auto, low, or high.");
  }

  for (const field of ["maxTokens", "maxBytes", "timeoutMs"]) {
    if (settings[field] !== undefined && (!Number.isSafeInteger(settings[field]) || settings[field] <= 0)) {
      throw new ReadImageError("INVALID_CONFIG", `${field} must be a positive integer.`);
    }
  }

  if (typeof settings.allowPrivateNetwork !== "boolean") {
    throw new ReadImageError("INVALID_CONFIG", "allowPrivateNetwork must be a boolean.");
  }

  return settings;
}

export async function loadConfigFile(filePath, options = {}) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && options.optional === true) {
      return {};
    }
    throw new ReadImageError("CONFIG_READ_FAILED", "The read-image-cli config file could not be read.", {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ReadImageError("INVALID_CONFIG", "The read-image-cli config file is not valid JSON.", {
      cause: error,
    });
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ReadImageError("INVALID_CONFIG", "The read-image-cli config must be a JSON object.");
  }

  return normalizeConfigObject(parsed);
}

function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveConfigPath(cliPath, env = process.env) {
  const configuredPath = cliPath || env.READ_IMAGE_CONFIG;
  if (!configuredPath) {
    return DEFAULT_CONFIG_PATH;
  }
  return path.resolve(expandHome(configuredPath));
}

export function resolveSettings({ config = {}, env = process.env, cli = {} } = {}) {
  const settings = { ...DEFAULTS };
  const sources = [normalizeConfigObject(config), readEnvironment(env), cli];

  for (const source of sources) {
    for (const [field, value] of Object.entries(source)) {
      if (value !== undefined && Object.hasOwn(DEFAULTS, field)) {
        settings[field] = value;
      }
    }
  }

  return validateSettings(settings);
}
