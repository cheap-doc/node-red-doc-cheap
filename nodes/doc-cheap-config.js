const { normalizeBaseUrl } = require("./lib/client.js");

// Holds the account settings the operation nodes share. The API key is a
// credential, so Node-RED stores it in the encrypted credentials file and
// never writes it into the flow JSON or an export.
module.exports = function register(RED) {
  function DocCheapConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.name = config.name;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  RED.nodes.registerType("doc-cheap-config", DocCheapConfigNode, {
    credentials: { apiKey: { type: "password" } },
  });
};
