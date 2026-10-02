const {
  buildScanRequest,
  callApi,
  globalFetch,
  handleInput,
  readImage,
} = require("./lib/client.js");

// Sends the image in msg.payload to POST /v1/scans and returns the scan result.
module.exports = function register(RED) {
  function DocCheapRecognizeNode(config) {
    RED.nodes.createNode(this, config);
    const server = RED.nodes.getNode(config.server);
    handleInput(this, async (msg) => {
      const image = await readImage(msg.payload, globalFetch);
      const { body, headers } = buildScanRequest(image, config, msg);
      const payload = await callApi({
        server,
        method: "POST",
        path: "/v1/scans",
        body,
        headers,
        fetchImpl: globalFetch,
      });
      // The scan's outcome (recognized, unreadable, …) sits in meta.status.
      const status = payload.meta?.status;
      return { payload, text: typeof status === "string" ? status : "done" };
    });
  }

  RED.nodes.registerType("doc-cheap-recognize", DocCheapRecognizeNode);
};
