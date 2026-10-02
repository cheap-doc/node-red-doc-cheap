const { callApi, globalFetch, handleInput } = require("./lib/client.js");

// Reads the account's credit balance and counters with GET /v1/usage, which
// spends nothing.
module.exports = function register(RED) {
  function DocCheapUsageNode(config) {
    RED.nodes.createNode(this, config);
    const server = RED.nodes.getNode(config.server);
    handleInput(this, async () => {
      const payload = await callApi({
        server,
        method: "GET",
        path: "/v1/usage",
        fetchImpl: globalFetch,
      });
      const balance = payload.balance_credits;
      return { payload, text: typeof balance === "number" ? `${balance} credits` : "ok" };
    });
  }

  RED.nodes.registerType("doc-cheap-usage", DocCheapUsageNode);
};
