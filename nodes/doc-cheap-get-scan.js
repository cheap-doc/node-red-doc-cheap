const { callApi, globalFetch, handleInput, readScanId, scanPath } = require("./lib/client.js");

// Reads a stored scan result back with GET /v1/scans/{id}.
module.exports = function register(RED) {
  function DocCheapGetScanNode(config) {
    RED.nodes.createNode(this, config);
    const server = RED.nodes.getNode(config.server);
    handleInput(this, async (msg) => {
      const id = readScanId(config, msg);
      const payload = await callApi({
        server,
        method: "GET",
        path: scanPath(id),
        fetchImpl: globalFetch,
      });
      return { payload, text: "found" };
    });
  }

  RED.nodes.registerType("doc-cheap-get-scan", DocCheapGetScanNode);
};
