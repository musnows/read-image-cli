#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

import { asReadImageError, ReadImageError } from "./errors.js";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_TIMEOUT_MS,
  loadImage,
} from "./image-input.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  extractResponseText,
  requestVision,
} from "./openai.js";

const DEFAULT_PROMPT = "Describe this image in detail.";
const require = createRequire(import.meta.url);
const packageInfo = require("../package.json");

function takeValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new ReadImageError("INVALID_ARGUMENT", `${option} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, option) {
  if (!/^\d+$/.test(value)) {
    throw new ReadImageError("INVALID_ARGUMENT", `${option} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReadImageError("INVALID_ARGUMENT", `${option} must be a positive integer.`);
  }
  return parsed;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    json: false,
    prompt: DEFAULT_PROMPT,
    model: env.OPENAI_MODEL || DEFAULT_MODEL,
    baseUrl: env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    detail: "auto",
    maxBytes: DEFAULT_MAX_IMAGE_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowPrivateNetwork: false,
  };
  let input;
  let showHelp = false;
  let showVersion = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      showHelp = true;
    } else if (argument === "--version" || argument === "-v") {
      showVersion = true;
    } else if (argument === "--prompt" || argument === "-p") {
      options.prompt = takeValue(argv, ++index, argument);
    } else if (argument === "--model" || argument === "-m") {
      options.model = takeValue(argv, ++index, argument);
    } else if (argument === "--base-url") {
      options.baseUrl = takeValue(argv, ++index, argument);
    } else if (argument === "--detail") {
      options.detail = takeValue(argv, ++index, argument);
      if (!["auto", "low", "high"].includes(options.detail)) {
        throw new ReadImageError("INVALID_ARGUMENT", "--detail must be auto, low, or high.");
      }
    } else if (argument === "--max-bytes") {
      options.maxBytes = parsePositiveInteger(takeValue(argv, ++index, argument), argument);
    } else if (argument === "--timeout") {
      options.timeoutMs = parsePositiveInteger(takeValue(argv, ++index, argument), argument);
    } else if (argument === "--max-tokens") {
      options.maxTokens = parsePositiveInteger(takeValue(argv, ++index, argument), argument);
    } else if (argument === "--allow-private-network") {
      options.allowPrivateNetwork = true;
    } else if (argument.startsWith("-")) {
      throw new ReadImageError("INVALID_ARGUMENT", `Unknown option: ${argument}`);
    } else if (input === undefined) {
      input = argument;
    } else {
      throw new ReadImageError("INVALID_ARGUMENT", "Only one image path or URL may be provided.");
    }
  }

  if (!showHelp && !showVersion && input === undefined) {
    throw new ReadImageError("MISSING_INPUT", "An absolute image path or an http(s) URL is required.");
  }

  return { ...options, input, showHelp, showVersion };
}

export function helpText() {
  return `read-image <absolute-path|http(s)-url> [options]

Read an image with an OpenAI-compatible vision chat completion API.

Options:
  --json                         Output one machine-readable JSON object
  -p, --prompt <text>            Prompt sent with the image
  -m, --model <model>            Vision model (default: OPENAI_MODEL or ${DEFAULT_MODEL})
  --base-url <url>               API base URL (default: OPENAI_BASE_URL or ${DEFAULT_BASE_URL})
  --detail <auto|low|high>       Image detail level (default: auto)
  --max-tokens <n>               Maximum completion tokens
  --max-bytes <n>                Maximum image size in bytes (default: ${DEFAULT_MAX_IMAGE_BYTES})
  --timeout <ms>                 Network timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --allow-private-network        Allow URL input to resolve to private networks
  -h, --help                     Show this help
  -v, --version                  Show the package version

Environment:
  OPENAI_API_KEY                 API key; required
  OPENAI_BASE_URL                API base URL; defaults to the OpenAI /v1 endpoint
  OPENAI_MODEL                   Vision model; defaults to ${DEFAULT_MODEL}
`;
}

function stripTerminalControls(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u2028\u2029]/g, "");
}

function getPackageVersion() {
  return packageInfo.version;
}

function writeOutput(io, value) {
  io.stdout.write(`${value}\n`);
}

function writeError(io, error, json) {
  const normalized = asReadImageError(error);
  if (json) {
    io.stderr.write(`${JSON.stringify({ error: { code: normalized.code, message: stripTerminalControls(normalized.message) }})}\n`);
    return;
  }

  io.stderr.write(`read-image: ${stripTerminalControls(normalized.message)}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {
  stdout: process.stdout,
  stderr: process.stderr,
}) {
  let parsed;
  try {
    parsed = parseArgs(argv, env);
    if (parsed.showHelp) {
      writeOutput(io, helpText());
      return 0;
    }
    if (parsed.showVersion) {
      writeOutput(io, getPackageVersion());
      return 0;
    }

    const image = await loadImage(parsed.input, {
      maxBytes: parsed.maxBytes,
      timeoutMs: parsed.timeoutMs,
      allowPrivateNetwork: parsed.allowPrivateNetwork,
    });
    const response = await requestVision({
      image,
      prompt: parsed.prompt,
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      apiKey: env.OPENAI_API_KEY,
      detail: parsed.detail,
      maxTokens: parsed.maxTokens,
      timeoutMs: parsed.timeoutMs,
    });

    const result = {
      text: extractResponseText(response),
      model: response.model || parsed.model,
      id: response.id || null,
      usage: response.usage || null,
      image: {
        source: image.source,
        mimeType: image.mimeType,
        bytes: image.bytes,
      },
    };

    if (parsed.json) {
      writeOutput(io, JSON.stringify(result));
    } else {
      writeOutput(io, stripTerminalControls(result.text));
    }
    return 0;
  } catch (error) {
    writeError(io, error, parsed?.json || argv.includes("--json"));
    return 1;
  }
}

let isDirectExecution = false;
try {
  isDirectExecution = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isDirectExecution = false;
}
if (isDirectExecution) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
