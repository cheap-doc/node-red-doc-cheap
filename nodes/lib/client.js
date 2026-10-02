// The request layer every doc.cheap node shares: reading the image out of a
// message, calling the API with the config node's key, and turning a failed
// call into one error with a short status-dot text and the API's own code.
// It uses only the runtime's own fetch, so the package has no dependencies.

const DEFAULT_BASE_URL = "https://api.doc.cheap";

// The largest image the API's own upload surfaces accept. A bigger file would
// be refused by the API anyway, so it is refused here before it is held in
// memory or sent.
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// How long a download of an image from a URL may take before it is abandoned.
const DOWNLOAD_TIMEOUT_MS = 30_000;

const COUNTRY_CODE = /^[A-Z]{3}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL = /^data:([^,]*?)(;base64)?,(.*)$/is;
const HTTP_URL = /^https?:\/\//i;
const MAX_RETAIN_HOURS = 8760;
const MAX_REFERENCE_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * A failure any doc.cheap node reports. `status` is the HTTP status when the
 * API answered, otherwise null; `code` is the API's error code, or one of this
 * package's own codes when the request never got an answer; `short` is the
 * text shown under the node.
 */
class DocCheapError extends Error {
  constructor(message, { status = null, code, short }) {
    super(message);
    this.name = "DocCheapError";
    this.status = status;
    this.code = code;
    this.short = short;
  }
}

function invalidInput(message) {
  return new DocCheapError(message, { code: "invalid_input", short: "invalid input" });
}

function normalizeBaseUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text === "" ? DEFAULT_BASE_URL : text).replace(/\/+$/, "");
}

function reasonOf(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

function tooLarge(what) {
  return invalidInput(`${what} is larger than 25 MiB, the most the API accepts.`);
}

// The decoded size of a base64 string, without decoding it.
function decodedLength(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function checkBase64(text, what) {
  const compact = text.replace(/\s+/g, "");
  if (compact === "" || !BASE64.test(compact)) {
    throw invalidInput(`${what} is not valid base64.`);
  }
  if (decodedLength(compact) > MAX_IMAGE_BYTES) throw tooLarge("The image");
  return compact;
}

// Reads a response body chunk by chunk and stops as soon as it passes the cap,
// so an oversized download is abandoned rather than held in memory first.
async function readCapped(response, url) {
  const chunks = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) throw tooLarge(`The image at ${url}`);
      chunks.push(chunk);
    }
  }
  if (total === 0) {
    throw new DocCheapError(`The image downloaded from ${url} is empty.`, {
      code: "download_failed",
      short: "download failed",
    });
  }
  return Buffer.concat(chunks);
}

async function downloadImage(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new DocCheapError(`Could not download the image from ${url}: ${reasonOf(error)}`, {
      code: "download_failed",
      short: "download failed",
    });
  }
  if (!response.ok) {
    throw new DocCheapError(
      `Downloading the image from ${url} failed with HTTP ${response.status}.`,
      { code: "download_failed", short: "download failed" },
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_IMAGE_BYTES) throw tooLarge(`The image at ${url}`);
  const bytes = await readCapped(response, url);
  return bytes.toString("base64");
}

/**
 * Turns `msg.payload` into the base64 image the API expects. Accepts a Buffer,
 * a base64 string, a `data:` URL with a base64 payload, or an http(s) URL,
 * which is downloaded first.
 */
async function readImage(payload, fetchImpl) {
  if (Buffer.isBuffer(payload)) {
    if (payload.length === 0) throw invalidInput("msg.payload is an empty Buffer.");
    if (payload.length > MAX_IMAGE_BYTES) throw tooLarge("The image");
    return payload.toString("base64");
  }
  if (typeof payload !== "string") {
    throw invalidInput(
      "msg.payload must be the image: a Buffer, a base64 string, a data URL or an http(s) URL.",
    );
  }
  const text = payload.trim();
  if (text === "") throw invalidInput("msg.payload is an empty string.");
  if (HTTP_URL.test(text)) return downloadImage(text, fetchImpl);
  const dataUrl = DATA_URL.exec(text);
  if (dataUrl) {
    if (!dataUrl[2]) throw invalidInput("A data URL in msg.payload must be base64-encoded.");
    return checkBase64(dataUrl[3], "The data URL in msg.payload");
  }
  return checkBase64(text, "msg.payload");
}

// A value from the message wins over the one set in the edit dialog, so one
// configured node can serve messages that each ask for something different.
function pick(fromMessage, fromConfig) {
  return fromMessage === undefined || fromMessage === null ? fromConfig : fromMessage;
}

function readCountry(value) {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (country === "") return undefined;
  if (!COUNTRY_CODE.test(country)) {
    throw invalidInput(`Expected country must be a three-letter code such as GRC, not "${value}".`);
  }
  return country;
}

function readRetainHours(value) {
  if (value === undefined || value === "") return undefined;
  const hours = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_RETAIN_HOURS) {
    throw invalidInput(`Retention hours must be a whole number from 0 to 8760, not "${value}".`);
  }
  return hours;
}

function readBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function readText(value, label, max) {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  if (text === "") return undefined;
  if (text.length > max) throw invalidInput(`${label} must be at most ${max} characters long.`);
  return text;
}

/**
 * Builds the body and headers of `POST /v1/scans` from the node's settings and
 * the message's overrides. Only the options that are set are sent, so the API
 * applies its own defaults to the rest.
 */
function buildScanRequest(image, config, msg) {
  const options = {};
  const country = readCountry(pick(msg.expectCountry, config.expectCountry));
  if (country !== undefined) options.expect_country = country;
  const portrait = readBoolean(pick(msg.returnPortrait, config.returnPortrait));
  if (portrait !== undefined) options.return_portrait = portrait;
  const hours = readRetainHours(pick(msg.retainHours, config.retainHours));
  if (hours !== undefined) options.retain_hours = hours;

  const body = { image };
  if (Object.keys(options).length > 0) body.options = options;
  const reference = readText(
    pick(msg.reference, config.reference),
    "Reference",
    MAX_REFERENCE_LENGTH,
  );
  if (reference !== undefined) body.reference = reference;

  const key = readText(
    pick(msg.idempotencyKey, config.idempotencyKey),
    "Idempotency key",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const headers = key === undefined ? {} : { "Idempotency-Key": key };
  return { body, headers };
}

/** The scan id from the node's setting, then `msg.scanId`, then a string `msg.payload`. */
function readScanId(config, msg) {
  const candidates = [config.scanId, msg.scanId, msg.payload];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  throw new DocCheapError(
    "No scan id: set one in the node, or send it as msg.scanId or as a string msg.payload.",
    { code: "missing_scan_id", short: "no scan id" },
  );
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function apiErrorOf(data) {
  const inner = data && typeof data === "object" ? data.error : undefined;
  if (inner && typeof inner.code === "string" && typeof inner.message === "string") {
    return inner;
  }
  return undefined;
}

// Maps a non-2xx answer to the error a flow sees. Only 401 and 403 mean the
// key is wrong; a 429 is the rate limit or the sandbox allowance, and saying
// "invalid key" there would send the user to replace a key that works.
function errorFromResponse(response, data) {
  const status = response.status;
  const body = apiErrorOf(data);
  const code = body ? body.code : `http_${status}`;
  const detail = body ? body.message : `doc.cheap answered HTTP ${status}.`;
  if (status === 401 || status === 403) {
    return new DocCheapError(`The API key was refused (HTTP ${status}): ${detail}`, {
      status,
      code,
      short: "invalid API key",
    });
  }
  if (status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
    return new DocCheapError(`Rate limited by doc.cheap (HTTP 429): ${detail}${wait}`, {
      status,
      code,
      short: "rate limited – try later",
    });
  }
  if (status === 404) {
    return new DocCheapError(`Not found (HTTP 404): ${detail}`, {
      status,
      code,
      short: "not found",
    });
  }
  return new DocCheapError(`doc.cheap request failed (HTTP ${status}): ${detail}`, {
    status,
    code,
    short: `error ${status}`,
  });
}

// The address and fetch options of one call: the config node's key as a Bearer
// token, and a JSON body only when one is given, so DELETE goes out with
// neither a body nor a content type.
function prepareRequest({ server, method, body, headers }) {
  if (!server) {
    throw new DocCheapError("No doc.cheap config node is selected in this node.", {
      code: "missing_config",
      short: "no config",
    });
  }
  const apiKey = server.credentials?.apiKey;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new DocCheapError("No API key: set one in the doc.cheap config node.", {
      code: "missing_api_key",
      short: "no API key",
    });
  }
  const init = {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey.trim()}`, ...headers },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return { baseUrl: normalizeBaseUrl(server.baseUrl), init };
}

// The parsed answer of a call, or the error a flow sees when it failed.
function parseAnswer(response, text) {
  const data = readJson(text);
  if (!response.ok) throw errorFromResponse(response, data);
  if (data === undefined) {
    throw new DocCheapError(`doc.cheap answered HTTP ${response.status} without a JSON body.`, {
      status: response.status,
      code: "invalid_response",
      short: "invalid response",
    });
  }
  return data;
}

/** Calls the API with the config node's key and returns the parsed JSON answer. */
async function callApi({ server, method, path, body, headers, fetchImpl }) {
  const { baseUrl, init } = prepareRequest({ server, method, body, headers });
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, init);
  } catch (error) {
    throw new DocCheapError(`Could not reach doc.cheap at ${baseUrl}: ${reasonOf(error)}`, {
      code: "network_error",
      short: "cannot reach doc.cheap",
    });
  }
  return parseAnswer(response, await response.text());
}

function scanPath(id) {
  return `/v1/scans/${encodeURIComponent(id)}`;
}

function toDocCheapError(error) {
  if (error instanceof DocCheapError) return error;
  return new DocCheapError(reasonOf(error), { code: "internal_error", short: "error" });
}

/**
 * Wires one operation into a node: the status dot while the request runs, the
 * answer into `msg.payload`, and on failure `msg.error` plus `node.error`, so a
 * Catch node receives the message. `operation(msg)` resolves to the payload
 * and the text for the green dot.
 */
function handleInput(node, operation) {
  node.on("input", async (msg, send, done) => {
    node.status({ fill: "yellow", shape: "dot", text: "requesting" });
    try {
      const { payload, text } = await operation(msg);
      msg.payload = payload;
      node.status({ fill: "green", shape: "dot", text });
      send(msg);
      done();
    } catch (raw) {
      const error = toDocCheapError(raw);
      msg.error = { status: error.status, code: error.code, message: error.message };
      node.status({ fill: "red", shape: "dot", text: error.short });
      node.error(error.message, msg);
      done();
    }
  });
}

// The runtime's own fetch, read when a request is made rather than when the
// module loads, so a test can put a stand-in in its place.
function globalFetch(...args) {
  return globalThis.fetch(...args);
}

module.exports = {
  DEFAULT_BASE_URL,
  MAX_IMAGE_BYTES,
  DocCheapError,
  buildScanRequest,
  callApi,
  globalFetch,
  handleInput,
  normalizeBaseUrl,
  readImage,
  readScanId,
  scanPath,
};
