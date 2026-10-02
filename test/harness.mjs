// A stand-in for the parts of the Node-RED runtime the nodes touch: creating a
// node, looking up the config node, the input handler, the status dot and
// node.error. A message is sent through the registered input handler exactly
// as the runtime would, and the test reads back what was sent and shown.
import { createRequire } from "node:module";
import { vi } from "vitest";

const require = createRequire(import.meta.url);

export const API_KEY = "dc_test_0000000000000000";

/**
 * A config node as the runtime hands it to an operation node. Passing
 * `apiKey: undefined` explicitly gives one whose credential was never set.
 */
export function configNode(options = {}) {
  const { baseUrl = "https://api.example.test" } = options;
  const apiKey = "apiKey" in options ? options.apiKey : API_KEY;
  return { baseUrl, credentials: apiKey === undefined ? {} : { apiKey } };
}

/**
 * Loads one node module against a fake RED and returns a function that builds
 * an instance of the registered type from an editor config.
 */
export function loadNode(file, { server = configNode() } = {}) {
  const registered = {};
  const RED = {
    nodes: {
      createNode(node, config) {
        node.handlers = {};
        node.on = (event, handler) => {
          node.handlers[event] = handler;
        };
        node.status = vi.fn();
        node.error = vi.fn();
        node.id = config.id;
      },
      getNode: (id) => (id === "server" ? server : null),
      registerType(type, ctor, options) {
        registered[type] = { constructor: ctor, options };
      },
    },
  };
  require(`../nodes/${file}`)(RED);
  const [type] = Object.keys(registered);
  return {
    type,
    options: registered[type].options,
    create(config = {}) {
      const node = {};
      registered[type].constructor.call(node, { id: "n1", server: "server", ...config });
      return node;
    },
  };
}

/** Sends one message through a node's input handler and collects what came out. */
export async function send(node, msg) {
  const sent = [];
  const done = vi.fn();
  await node.handlers.input(msg, (out) => sent.push(out), done);
  return { sent, done, statuses: node.status.mock.calls.map(([status]) => status) };
}

/** A fetch Response stand-in carrying a JSON (or raw text) answer. */
export function jsonResponse(status, data, headers = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
