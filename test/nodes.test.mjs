// Each node end to end inside a stand-in runtime: a message goes in through
// the input handler, the runtime's fetch is replaced, and the test reads the
// request that went out, the message that came back and the status dot.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY, configNode, jsonResponse, loadNode, send } from "./harness.mjs";

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SCAN_ID = "00000000-0000-7000-8000-000000000000";
let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastStatus = (statuses) => statuses[statuses.length - 1];

describe("doc-cheap-config", () => {
  it("keeps the key as a password credential and normalises the address", () => {
    const loaded = loadNode("doc-cheap-config.js");
    expect(loaded.type).toBe("doc-cheap-config");
    expect(loaded.options).toEqual({ credentials: { apiKey: { type: "password" } } });
    const node = loaded.create({ name: "account", baseUrl: "http://localhost:3000/" });
    expect(node.name).toBe("account");
    expect(node.baseUrl).toBe("http://localhost:3000");
    expect(loaded.create({ baseUrl: "" }).baseUrl).toBe("https://api.doc.cheap");
  });

  it("is never written with a key into the shipped example flow", () => {
    const flow = JSON.parse(
      readFileSync(new URL("../examples/doc-cheap-operations.json", import.meta.url), "utf8"),
    );
    const types = flow.map((node) => node.type);
    for (const type of [
      "doc-cheap-config",
      "doc-cheap-recognize",
      "doc-cheap-get-scan",
      "doc-cheap-delete-scan",
      "doc-cheap-usage",
    ]) {
      expect(types).toContain(type);
    }
    for (const node of flow) {
      expect(node.credentials).toBeUndefined();
      expect(JSON.stringify(node)).not.toMatch(/apiKey|dc_live|dc_test/);
    }
  });
});

describe("doc-cheap-recognize", () => {
  const recognize = loadNode("doc-cheap-recognize.js");

  it("posts the image with the options and shows the scan's status", async () => {
    const answer = { meta: { id: SCAN_ID, status: "recognized", billed: true }, document: {} };
    fetchMock.mockResolvedValue(jsonResponse(201, answer));
    const node = recognize.create({
      expectCountry: "UTO",
      returnPortrait: true,
      retainHours: "24",
    });

    const { sent, done, statuses } = await send(node, { payload: BYTES, idempotencyKey: "k-1" });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual(answer);
    expect(done).toHaveBeenCalledOnce();
    expect(statuses[0]).toEqual({ fill: "yellow", shape: "dot", text: "requesting" });
    expect(lastStatus(statuses)).toEqual({ fill: "green", shape: "dot", text: "recognized" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/scans");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(init.body)).toEqual({
      image: BYTES.toString("base64"),
      options: { expect_country: "UTO", return_portrait: true, retain_hours: 24 },
    });
  });

  it("downloads an image URL before posting it", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(BYTES, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(201, { meta: {} }));
    const { sent, statuses } = await send(recognize.create(), {
      payload: "https://files.example.test/document.png",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://files.example.test/document.png");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).image).toBe(BYTES.toString("base64"));
    expect(sent).toHaveLength(1);
    // A scan answer without a status string still shows success.
    expect(lastStatus(statuses).text).toBe("done");
  });

  it("shows done when the answer has no meta block", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { document: {} }));
    const { statuses } = await send(recognize.create(), { payload: BYTES.toString("base64") });
    expect(lastStatus(statuses).text).toBe("done");
  });

  it("reports a failed download without calling the API", async () => {
    fetchMock.mockResolvedValue(new Response("missing", { status: 404 }));
    const node = recognize.create();
    const msg = { payload: "https://files.example.test/missing.png" };
    const { sent, done, statuses } = await send(node, msg);
    expect(sent).toHaveLength(0);
    expect(done).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(msg.error).toMatchObject({ status: null, code: "download_failed" });
    expect(lastStatus(statuses)).toEqual({ fill: "red", shape: "dot", text: "download failed" });
    expect(node.error).toHaveBeenCalledWith(msg.error.message, msg);
  });

  it("reports invalid input without calling the API", async () => {
    const msg = { payload: 12 };
    const { statuses } = await send(recognize.create(), msg);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.error.code).toBe("invalid_input");
    expect(lastStatus(statuses).text).toBe("invalid input");
  });

  it("reports a rate limit as a rate limit", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { code: "rate_limited", message: "Slow down." } }),
    );
    const msg = { payload: BYTES };
    const { statuses } = await send(recognize.create(), msg);
    expect(msg.error).toEqual({
      status: 429,
      code: "rate_limited",
      message: "Rate limited by doc.cheap (HTTP 429): Slow down.",
    });
    expect(lastStatus(statuses)).toEqual({
      fill: "red",
      shape: "dot",
      text: "rate limited – try later",
    });
  });

  it("reports a missing config node", async () => {
    const node = loadNode("doc-cheap-recognize.js", { server: null }).create();
    const msg = { payload: BYTES };
    await send(node, msg);
    expect(msg.error.code).toBe("missing_config");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("doc-cheap-get-scan", () => {
  const getScan = loadNode("doc-cheap-get-scan.js");

  it("reads the scan named by msg.scanId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { meta: { id: SCAN_ID } }));
    const { sent, statuses } = await send(getScan.create(), { scanId: SCAN_ID });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.example.test/v1/scans/${SCAN_ID}`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(sent[0].payload).toEqual({ meta: { id: SCAN_ID } });
    expect(lastStatus(statuses)).toEqual({ fill: "green", shape: "dot", text: "found" });
  });

  it("reports a missing id without calling the API", async () => {
    const msg = { payload: {} };
    const { sent, statuses } = await send(getScan.create(), msg);
    expect(sent).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(msg.error.code).toBe("missing_scan_id");
    expect(lastStatus(statuses).text).toBe("no scan id");
  });

  it("reports an unknown scan as not found", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: "not_found", message: "No such scan." } }),
    );
    const msg = { payload: SCAN_ID };
    const { statuses } = await send(getScan.create(), msg);
    expect(msg.error).toMatchObject({ status: 404, code: "not_found" });
    expect(lastStatus(statuses).text).toBe("not found");
  });

  it("reports a refused key", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: "invalid_api_key", message: "Unknown key." } }),
    );
    const msg = { payload: SCAN_ID };
    const { statuses } = await send(getScan.create(), msg);
    expect(msg.error.status).toBe(401);
    expect(lastStatus(statuses).text).toBe("invalid API key");
  });
});

describe("doc-cheap-delete-scan", () => {
  const deleteScan = loadNode("doc-cheap-delete-scan.js");

  it("deletes the scan set in the node, with no body and no content type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: SCAN_ID, deleted: true }));
    const { sent, statuses } = await send(deleteScan.create({ scanId: SCAN_ID }), {
      payload: "ignored",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.example.test/v1/scans/${SCAN_ID}`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect(sent[0].payload).toEqual({ id: SCAN_ID, deleted: true });
    expect(lastStatus(statuses).text).toBe("deleted");
  });

  it("reports a network failure as doc.cheap being unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const msg = { payload: SCAN_ID };
    const { statuses } = await send(deleteScan.create(), msg);
    expect(msg.error).toMatchObject({ status: null, code: "network_error" });
    expect(lastStatus(statuses)).toEqual({
      fill: "red",
      shape: "dot",
      text: "cannot reach doc.cheap",
    });
  });
});

describe("doc-cheap-usage", () => {
  const usage = loadNode("doc-cheap-usage.js");

  it("shows the balance of a live key", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { balance_credits: 140 }));
    const { sent, statuses } = await send(usage.create(), { payload: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/usage");
    expect(init.method).toBe("GET");
    expect(sent[0].payload).toEqual({ balance_credits: 140 });
    expect(lastStatus(statuses).text).toBe("140 credits");
  });

  it("shows ok for a key without a balance", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { balance_credits: null }));
    const { statuses } = await send(usage.create(), {});
    expect(lastStatus(statuses).text).toBe("ok");
  });

  it("reports a missing key", async () => {
    const node = loadNode("doc-cheap-usage.js", {
      server: configNode({ apiKey: undefined }),
    }).create();
    const msg = {};
    const { statuses } = await send(node, msg);
    expect(msg.error.code).toBe("missing_api_key");
    expect(lastStatus(statuses).text).toBe("no API key");
  });
});
