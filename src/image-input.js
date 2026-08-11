import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import path, { win32 as win32Path } from "node:path";

import { ReadImageError } from "./errors.js";

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function readAscii(bytes, start, end) {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function hasPrefix(bytes, prefix) {
  if (bytes.length < prefix.length) {
    return false;
  }

  return prefix.every((value, index) => bytes[index] === value);
}

function isJpeg(bytes) {
  if (!hasPrefix(bytes, [0xff, 0xd8, 0xff]) || bytes.length < 4) {
    return false;
  }

  let offset = 2;
  let sawFrame = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= bytes.length) {
      break;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0x00) {
      continue;
    }

    if (marker === 0xd9) {
      return sawFrame;
    }

    if (marker === 0xda) {
      for (let index = offset; index + 1 < bytes.length; index += 1) {
        if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
          return sawFrame;
        }
      }
      return false;
    }

    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > bytes.length) {
      return false;
    }

    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return false;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      if (segmentLength < 7) {
        return false;
      }

      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) {
        return false;
      }
      sawFrame = true;
    }

    offset += segmentLength;
  }

  return false;
}

function detectPng(bytes) {
  if (!hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return false;
  }

  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || readAscii(bytes, 12, 16) !== "IHDR") {
    return false;
  }

  return bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
}

function detectGif(bytes) {
  if (bytes.length < 13 || !["GIF87a", "GIF89a"].includes(readAscii(bytes, 0, 6))) {
    return false;
  }

  return bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0;
}

function detectWebp(bytes) {
  if (bytes.length < 20 || readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 12) !== "WEBP") {
    return false;
  }

  const riffLength = bytes.readUInt32LE(4) + 8;
  if (riffLength > bytes.length) {
    return false;
  }

  return ["VP8 ", "VP8L", "VP8X"].includes(readAscii(bytes, 12, 16));
}

export function detectImageType(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);

  if (detectPng(bytes)) {
    return { extension: "png", mimeType: "image/png" };
  }

  if (isJpeg(bytes)) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }

  if (detectGif(bytes)) {
    return { extension: "gif", mimeType: "image/gif" };
  }

  if (detectWebp(bytes)) {
    return { extension: "webp", mimeType: "image/webp" };
  }

  return null;
}

function parseIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isPrivateIpv4(hostname) {
  const parts = parseIpv4(hostname);
  if (!parts) {
    return false;
  }

  const [first, second, third] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function expandIpv6(hostname) {
  const parts = hostname.toLowerCase().split("::");
  if (parts.length > 2) {
    return null;
  }

  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];

  const parseHextets = (values) => {
    const result = [];
    for (const value of values) {
      if (!/^[0-9a-f]{1,4}$/.test(value)) {
        return null;
      }
      result.push(Number.parseInt(value, 16));
    }
    return result;
  };

  const leftValues = parseHextets(left);
  const rightValues = parseHextets(right);
  if (!leftValues || !rightValues) {
    return null;
  }

  if (parts.length === 1) {
    return leftValues.length === 8 ? leftValues : null;
  }

  const missing = 8 - leftValues.length - rightValues.length;
  if (missing < 1) {
    return null;
  }

  return [...leftValues, ...new Array(missing).fill(0), ...rightValues];
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4[1])) {
    return true;
  }

  const values = expandIpv6(normalized);
  if (!values) {
    return true;
  }

  const first = values[0];
  const second = values[1];
  return (
    values.every((value) => value === 0) ||
    values.slice(0, 7).every((value) => value === 0) && values[7] === 1 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && (second & 0xfff0) === 0x0010)
  );
}

function isPrivateAddress(address) {
  const normalized = address.replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) {
    return isPrivateIpv4(normalized);
  }
  if (family === 6) {
    return isPrivateIpv6(normalized);
  }
  return true;
}

function getHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ReadImageError("INVALID_URL", "The image URL is invalid.", { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ReadImageError("UNSUPPORTED_URL_SCHEME", "Only http:// and https:// image URLs are allowed.");
  }

  if (!url.hostname || url.username || url.password) {
    throw new ReadImageError("UNSAFE_URL", "The image URL must have a host and must not contain credentials.");
  }

  return url;
}

export function classifyInput(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new ReadImageError("MISSING_INPUT", "An absolute image path or an http(s) URL is required.");
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
    return { kind: "url", url: parseHttpUrl(input) };
  }

  if (!path.isAbsolute(input) && !win32Path.isAbsolute(input)) {
    throw new ReadImageError("PATH_NOT_ABSOLUTE", "Local image paths must be absolute paths.");
  }

  return { kind: "file", path: input };
}

export async function assertSafeUrl(url, options = {}) {
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  if (allowPrivateNetwork) {
    return;
  }

  const hostname = getHostname(url);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new ReadImageError("PRIVATE_NETWORK_BLOCKED", "Private and local network image URLs are blocked by default.");
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new ReadImageError("PRIVATE_NETWORK_BLOCKED", "Private and local network image URLs are blocked by default.");
    }
    return;
  }

  const lookupImpl = options.lookupImpl ?? lookup;
  let records;
  try {
    records = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new ReadImageError("DNS_LOOKUP_FAILED", "The image URL host could not be resolved.", { cause: error });
  }

  if (!Array.isArray(records) || records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new ReadImageError("PRIVATE_NETWORK_BLOCKED", "The image URL resolves to a private or local network.");
  }
}

export async function readResponseBytes(response, maxBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number.isSafeInteger(Number(contentLength)) && Number(contentLength) > maxBytes) {
    throw new ReadImageError("IMAGE_TOO_LARGE", `The image response exceeds the ${maxBytes}-byte limit.`);
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new ReadImageError("IMAGE_TOO_LARGE", `The image response exceeds the ${maxBytes}-byte limit.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ReadImageError("IMAGE_TOO_LARGE", `The image response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks, total);
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function downloadImage(url, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ReadImageError("FETCH_UNAVAILABLE", "This Node.js runtime does not provide fetch().");
  }

  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const timeout = createTimeoutSignal(timeoutMs);
  let currentUrl = url;

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      await assertSafeUrl(currentUrl, options);

      let response;
      try {
        response = await fetchImpl(currentUrl, {
          redirect: "manual",
          signal: timeout.signal,
          headers: { accept: "image/*" },
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new ReadImageError("REQUEST_TIMEOUT", `The image request timed out after ${timeoutMs} ms.`, {
            cause: error,
          });
        }
        throw new ReadImageError("IMAGE_FETCH_FAILED", "The image URL could not be fetched.", { cause: error });
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount === maxRedirects) {
          throw new ReadImageError("TOO_MANY_REDIRECTS", "The image URL redirected too many times.");
        }

        const location = response.headers?.get?.("location");
        if (!location) {
          throw new ReadImageError("INVALID_REDIRECT", "The image URL returned a redirect without a location.");
        }

        try {
          currentUrl = parseHttpUrl(new URL(location, currentUrl).toString());
        } catch (error) {
          if (error instanceof ReadImageError) {
            throw error;
          }
          throw new ReadImageError("INVALID_REDIRECT", "The image URL returned an invalid redirect.", { cause: error });
        }

        await response.body?.cancel?.();
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ReadImageError("IMAGE_FETCH_FAILED", `The image URL returned HTTP ${response.status}.`);
      }

      const bytes = await readResponseBytes(response, maxBytes);
      return { bytes, finalUrl: currentUrl.toString() };
    }
  } finally {
    timeout.cleanup();
  }

  throw new ReadImageError("IMAGE_FETCH_FAILED", "The image URL could not be fetched.");
}

export async function loadImage(input, options = {}) {
  const classified = classifyInput(input);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  if (classified.kind === "file") {
    let fileStats;
    try {
      fileStats = await stat(classified.path);
    } catch (error) {
      throw new ReadImageError("FILE_READ_FAILED", "The local image file could not be read.", { cause: error });
    }

    if (!fileStats.isFile()) {
      throw new ReadImageError("NOT_A_FILE", "The local image path is not a regular file.");
    }

    if (fileStats.size > maxBytes) {
      throw new ReadImageError("IMAGE_TOO_LARGE", `The image file exceeds the ${maxBytes}-byte limit.`);
    }

    let bytes;
    try {
      bytes = await readFile(classified.path);
    } catch (error) {
      throw new ReadImageError("FILE_READ_FAILED", "The local image file could not be read.", { cause: error });
    }

    if (bytes.length > maxBytes) {
      throw new ReadImageError("IMAGE_TOO_LARGE", `The image file exceeds the ${maxBytes}-byte limit.`);
    }

    const type = detectImageType(bytes);
    if (!type) {
      throw new ReadImageError("UNSUPPORTED_IMAGE", "The file does not contain a supported raster image format.");
    }

    return {
      source: "file",
      input,
      bytes: bytes.length,
      mimeType: type.mimeType,
      dataUrl: `data:${type.mimeType};base64,${bytes.toString("base64")}`,
    };
  }

  const downloaded = await downloadImage(classified.url, {
    ...options,
    maxBytes,
  });
  const type = detectImageType(downloaded.bytes);
  if (!type) {
    throw new ReadImageError("UNSUPPORTED_REMOTE_IMAGE", "The HTTP response is not a supported raster image.");
  }

  return {
    source: "url",
    input,
    finalUrl: downloaded.finalUrl,
    bytes: downloaded.bytes.length,
    mimeType: type.mimeType,
    dataUrl: `data:${type.mimeType};base64,${downloaded.bytes.toString("base64")}`,
  };
}
