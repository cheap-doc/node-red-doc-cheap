const { callApi, globalFetch, handleInput, readScanId, scanPath } = require("./lib/client.js");

// Deletes a stored scan result with DELETE /v1/scans/{id}. The request carries
// no body, so callApi sends no content type with it either.
module.exports = function register(RED) {
  function DocCheapDeleteScanNode(config) {
    RED.nodes.createNode(this, config);
    const server = RED.nodes.getNode(config.server);
    handleInput(this, async (msg) => {
      const id = readScanId(config, msg);
      const payload = await callApi({
        server,
        method: "DELETE",
        path: scanPath(id),
        fetchImpl: globalFetch,
      });
      return { payload, text: "deleted" };
    });
  }

  RED.nodes.registerType("doc-cheap-delete-scan", DocCheapDeleteScanNode);
};
