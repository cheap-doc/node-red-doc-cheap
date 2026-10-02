// The request layer: how a message becomes a request, and how every kind of
// failure becomes the error a flow sees. fetch is always a stand-in here;
// nothing reaches the network.
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { API_KEY, configNode, jsonResponse } from "./harness.mjs";

const require = createRequire(import.meta.url);
const client = require("../nodes/lib/client.js");
const {
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
} = client;

// A few synthetic bytes standing in for an image; the API is never called.
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
const BASE64 = BYTES.toString("base64");

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("normalizeBaseUrl", () => {
  it("falls back to the public API and drops trailing slashes", () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_BASE_URL);
    expect(normalizeBaseUrl("  ")).toBe(DEFAULT_BASE_URL);
    expect(normalizeBaseUrl(" http://localhost:3000// ")).toBe("http://localhost:3000");
  });
});

describe("readImage", () => {
  const noFetch = () => {
    throw new Error("fetch must not be called");
  };

  it("accepts a Buffer", async () => {
    expect(await readImage(BYTES, noFetch)).toBe(BASE64);
  });

  it("refuses an empty or oversized Buffer", async () => {
    expect((await rejection(readImage(Buffer.alloc(0), noFetch))).code).toBe("invalid_input");
    const big = await rejection(readImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), noFetch));
    expect(big.message).toMatch(/larger than 25 MiB/);
  });

  it("accepts base64, ignoring whitespace", async () => {
    const wrapped = `${BASE64.slice(0, 4)}\n${BASE64.slice(4)}  `;
    expect(await readImage(wrapped, noFetch)).toBe(BASE64);
    expect(await readImage("QQ==", noFetch)).toBe("QQ==");
    expect(await readImage("QUI=", noFetch)).toBe("QUI=");
  });

  it("refuses something that is not base64", async () => {
    const error = await rejection(readImage("not base64!", noFetch));
    expect(error).toBeInstanceOf(DocCheapError);
    expect(error.code).toBe("invalid_input");
    expect(error.short).toBe("invalid input");
    expect(error.status).toBeNull();
  });

  it("refuses base64 that decodes to more than the cap", async () => {
    const huge = "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 3) / 3) * 4);
    expect((await rejection(readImage(huge, noFetch))).message).toMatch(/25 MiB/);
  });

  it("accepts a base64 data URL and refuses a plain one", async () => {
    expect(await readImage(`data:image/jpeg;base64,${BASE64}`, noFetch)).toBe(BASE64);
    const error = await rejection(readImage("data:text/plain,hello", noFetch));
    expect(error.message).toMatch(/base64-encoded/);
    const empty = await rejection(readImage("data:image/png;base64,", noFetch));
    expect(empty.message).toMatch(/data URL in msg.payload is not valid base64/);
  });

  it("refuses a missing, non-string or empty payload", async () => {
    for (const payload of [undefined, null, 42, { image: BASE64 }]) {
      expect((await rejection(readImage(payload, noFetch))).message).toMatch(/must be the image/);
    }
    expect((await rejection(readImage("   ", noFetch))).message).toMatch(/empty string/);
  });

  it("downloads an http(s) URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(BYTES, { status: 200 }));
    expect(await readImage(" https://files.example.test/doc.jpg ", fetchImpl)).toBe(BASE64);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://files.example.test/doc.jpg");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("joins a download that arrives in several chunks", async () => {
    const body = streamOf([BYTES.subarray(0, 3), BYTES.subarray(3)]);
    const fetchImpl = async () => new Response(body, { status: 200 });
    expect(await readImage("http://files.example.test/doc.jpg", fetchImpl)).toBe(BASE64);
  });

  it("reports a download that could not connect", async () => {
    const cause = new Error("connect ECONNREFUSED");
    const fetchImpl = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    const error = await rejection(readImage("https://files.example.test/a.jpg", fetchImpl));
    expect(error.code).toBe("download_failed");
    expect(error.short).toBe("download failed");
    expect(error.message).toMatch(/fetch failed: connect ECONNREFUSED/);
  });

  it("reports a download that threw something other than an Error", async () => {
    const fetchImpl = async () => {
      throw "socket closed";
    };
    const error = await rejection(readImage("https://files.example.test/a.jpg", fetchImpl));
    expect(error.message).toMatch(/socket closed/);
  });

  it("reports a download answered with an error status", async () => {
    const fetchImpl = async () => new Response("gone", { status: 404 });
    const error = await rejection(readImage("https://files.example.test/a.jpg", fetchImpl));
    expect(error.code).toBe("download_failed");
    expect(error.message).toMatch(/HTTP 404/);
  });

  it("refuses a download that declares or streams more than the cap", async () => {
    const declared = async () =>
      new Response(BYTES, {
        status: 200,
        headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
      });
    expect(
      (await rejection(readImage("https://files.example.test/a.jpg", declared))).message,
    ).toMatch(/25 MiB/);

    const chunk = new Uint8Array(MAX_IMAGE_BYTES / 2 + 1);
    const streamed = async () => new Response(streamOf([chunk, chunk]), { status: 200 });
    const error = await rejection(readImage("https://files.example.test/a.jpg", streamed));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(/25 MiB/);
  });

  it("refuses an empty download, with or without a body", async () => {
    const empty = async () => new Response(new Uint8Array(0), { status: 200 });
    const noBody = async () => new Response(null, { status: 200 });
    for (const fetchImpl of [empty, noBody]) {
      const error = await rejection(readImage("https://files.example.test/a.jpg", fetchImpl));
      expect(error.code).toBe("download_failed");
      expect(error.message).toMatch(/is empty/);
    }
  });
});

describe("buildScanRequest", () => {
  it("sends only the image when nothing is set", () => {
    expect(buildScanRequest(BASE64, {}, {})).toEqual({ body: { image: BASE64 }, headers: {} });
    const blank = {
      expectCountry: "",
      returnPortrait: "",
      retainHours: "",
      reference: "",
      idempotencyKey: "  ",
    };
    expect(buildScanRequest(BASE64, blank, {})).toEqual({ body: { image: BASE64 }, headers: {} });
  });

  it("takes every option from the node settings", () => {
    const config = {
      expectCountry: "grc",
      returnPortrait: false,
      retainHours: "48",
      reference: " order-1 ",
      idempotencyKey: "key-1",
    };
    expect(buildScanRequest(BASE64, config, {})).toEqual({
      body: {
        image: BASE64,
        options: { expect_country: "GRC", return_portrait: false, retain_hours: 48 },
        reference: "order-1",
      },
      headers: { "Idempotency-Key": "key-1" },
    });
  });

  it("lets the message override the node settings", () => {
    const config = {
      expectCountry: "GRC",
      returnPortrait: true,
      retainHours: "48",
      reference: "a",
    };
    const msg = {
      expectCountry: "UTO",
      returnPortrait: "false",
      retainHours: 0,
      reference: 12345,
      idempotencyKey: "from-msg",
    };
    expect(buildScanRequest(BASE64, config, msg)).toEqual({
      body: {
        image: BASE64,
        options: { expect_country: "UTO", return_portrait: false, retain_hours: 0 },
        reference: "12345",
      },
      headers: { "Idempotency-Key": "from-msg" },
    });
    // null in the message keeps the node's own value.
    const kept = buildScanRequest(BASE64, config, { expectCountry: null, returnPortrait: "true" });
    expect(kept.body.options).toEqual({
      expect_country: "GRC",
      return_portrait: true,
      retain_hours: 48,
    });
  });

  it("ignores a portrait flag that is not a boolean", () => {
    expect(buildScanRequest(BASE64, { returnPortrait: "yes" }, {}).body).toEqual({ image: BASE64 });
  });

  it("refuses a country that is not three letters", () => {
    expect(() => buildScanRequest(BASE64, { expectCountry: "GR" }, {})).toThrow(/three-letter/);
    expect(() => buildScanRequest(BASE64, {}, { expectCountry: 7 })).not.toThrow();
  });

  it("refuses retention hours outside 0 to 8760", () => {
    for (const retainHours of ["-1", "8761", "1.5", "two", 9000]) {
      expect(() => buildScanRequest(BASE64, { retainHours }, {})).toThrow(/0 to 8760/);
    }
    expect(buildScanRequest(BASE64, { retainHours: 8760 }, {}).body.options).toEqual({
      retain_hours: 8760,
    });
  });

  it("refuses an over-long reference or idempotency key", () => {
    expect(() => buildScanRequest(BASE64, { reference: "r".repeat(129) }, {})).toThrow(
      /Reference must be at most 128/,
    );
    expect(() => buildScanRequest(BASE64, {}, { idempotencyKey: "k".repeat(256) })).toThrow(
      /Idempotency key must be at most 255/,
    );
  });
});

describe("readScanId", () => {
  it("prefers the node setting, then msg.scanId, then a string payload", () => {
    expect(readScanId({ scanId: " a " }, { scanId: "b", payload: "c" })).toBe("a");
    expect(readScanId({ scanId: "" }, { scanId: "b", payload: "c" })).toBe("b");
    expect(readScanId({}, { scanId: " ", payload: " c " })).toBe("c");
  });

  it("refuses when there is no id", () => {
    let error;
    try {
      readScanId({}, { payload: { id: "x" } });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("missing_scan_id");
    expect(error.short).toBe("no scan id");
  });

  it("escapes the id in the path", () => {
    expect(scanPath("a/b c")).toBe("/v1/scans/a%2Fb%20c");
  });
});

describe("callApi", () => {
  const server = configNode({ baseUrl: "https://api.example.test/" });

  it("sends a JSON body with the key as a Bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const data = await callApi({
      server,
      method: "POST",
      path: "/v1/scans",
      body: { image: BASE64 },
      headers: { "Idempotency-Key": "k" },
      fetchImpl,
    });
    expect(data).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/scans");
    expect(init).toEqual({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "Idempotency-Key": "k",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image: BASE64 }),
    });
  });

  it("sends neither a body nor a content type without a body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "x", deleted: true }));
    await callApi({ server, method: "DELETE", path: "/v1/scans/x", fetchImpl });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("uses the public API when the config node has no address", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    await callApi({
      server: { credentials: { apiKey: " k " } },
      method: "GET",
      path: "/v1/usage",
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.doc.cheap/v1/usage");
    expect(init.headers.Authorization).toBe("Bearer k");
  });

  it("refuses without a config node or a key", async () => {
    const fetchImpl = vi.fn();
    const noConfig = await rejection(
      callApi({ server: null, method: "GET", path: "/", fetchImpl }),
    );
    expect(noConfig.code).toBe("missing_config");
    for (const bad of [configNode({ apiKey: undefined }), configNode({ apiKey: "  " }), {}]) {
      const error = await rejection(callApi({ server: bad, method: "GET", path: "/", fetchImpl }));
      expect(error.code).toBe("missing_api_key");
      expect(error.short).toBe("no API key");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure as doc.cheap being unreachable", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await rejection(callApi({ server, method: "GET", path: "/v1/usage", fetchImpl }));
    expect(error.code).toBe("network_error");
    expect(error.short).toBe("cannot reach doc.cheap");
    expect(error.message).toBe(
      "Could not reach doc.cheap at https://api.example.test: fetch failed",
    );
  });

  it.each([401, 403])("reports HTTP %i as a refused key", async (status) => {
    const body = { error: { code: "invalid_api_key", message: "Unknown key." } };
    const fetchImpl = async () => jsonResponse(status, body);
    const error = await rejection(callApi({ server, method: "GET", path: "/v1/usage", fetchImpl }));
    expect(error).toMatchObject({ status, code: "invalid_api_key", short: "invalid API key" });
    expect(error.message).toBe(`The API key was refused (HTTP ${status}): Unknown key.`);
  });

  it("reports HTTP 429 as a rate limit, never as a bad key", async () => {
    const body = { error: { code: "rate_limited", message: "Too many requests." } };
    const withHeader = async () => jsonResponse(429, body, { "retry-after": "30" });
    const error = await rejection(
      callApi({ server, method: "POST", path: "/v1/scans", body: {}, fetchImpl: withHeader }),
    );
    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    expect(error.short).toBe("rate limited – try later");
    expect(error.short).not.toMatch(/key/i);
    expect(error.message).toBe(
      "Rate limited by doc.cheap (HTTP 429): Too many requests. Retry after 30 seconds.",
    );

    const without = async () => jsonResponse(429, body);
    const plain = await rejection(
      callApi({ server, method: "GET", path: "/", fetchImpl: without }),
    );
    expect(plain.message).toBe("Rate limited by doc.cheap (HTTP 429): Too many requests.");
  });

  it("reports HTTP 404 as not found", async () => {
    const body = { error: { code: "not_found", message: "No such scan." } };
    const fetchImpl = async () => jsonResponse(404, body);
    const error = await rejection(
      callApi({ server, method: "GET", path: "/v1/scans/x", fetchImpl }),
    );
    expect(error).toMatchObject({ status: 404, code: "not_found", short: "not found" });
  });

  it("reports any other status with the API's code, or its own when the body has none", async () => {
    const coded = async () =>
      jsonResponse(422, { error: { code: "image_unreadable", message: "Bad image." } });
    const error = await rejection(callApi({ server, method: "GET", path: "/", fetchImpl: coded }));
    expect(error).toMatchObject({ status: 422, code: "image_unreadable", short: "error 422" });
    expect(error.message).toBe("doc.cheap request failed (HTTP 422): Bad image.");

    for (const raw of ["<html>bad gateway</html>", { error: "x" }, { error: { code: 1 } }, null]) {
      const fetchImpl = async () => jsonResponse(502, raw === null ? "null" : raw);
      const bare = await rejection(callApi({ server, method: "GET", path: "/", fetchImpl }));
      expect(bare).toMatchObject({ status: 502, code: "http_502", short: "error 502" });
      expect(bare.message).toBe(
        "doc.cheap request failed (HTTP 502): doc.cheap answered HTTP 502.",
      );
    }
  });

  it("refuses a success answer that is not JSON", async () => {
    const fetchImpl = async () => new Response("ok", { status: 200 });
    const error = await rejection(callApi({ server, method: "GET", path: "/", fetchImpl }));
    expect(error).toMatchObject({
      status: 200,
      code: "invalid_response",
      short: "invalid response",
    });
  });
});

describe("handleInput", () => {
  function fakeNode() {
    const node = { status: vi.fn(), error: vi.fn() };
    node.on = (_event, handler) => {
      node.input = handler;
    };
    return node;
  }

  it("turns an unexpected exception into an internal error", async () => {
    const node = fakeNode();
    handleInput(node, async () => {
      throw new RangeError("boom");
    });
    const msg = {};
    const done = vi.fn();
    await node.input(msg, vi.fn(), done);
    expect(msg.error).toEqual({ status: null, code: "internal_error", message: "boom" });
    expect(node.status).toHaveBeenLastCalledWith({ fill: "red", shape: "dot", text: "error" });
    expect(node.error).toHaveBeenCalledWith("boom", msg);
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("globalFetch", () => {
  it("calls the runtime's fetch at the time of the request", async () => {
    const stand = vi.fn(async () => "answer");
    vi.stubGlobal("fetch", stand);
    try {
      expect(await globalFetch("https://x.example.test", { method: "GET" })).toBe("answer");
      expect(stand).toHaveBeenCalledWith("https://x.example.test", { method: "GET" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
