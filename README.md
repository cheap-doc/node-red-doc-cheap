# node-red-doc-cheap

[Node-RED](https://nodered.org/) nodes for [doc.cheap](https://doc.cheap): they
read a photo or scan of a passport, national ID card or driving licence and
return the printed fields – name, date of birth, document number, expiry, the
machine-readable zone – as a message payload.

One recognised document costs one credit, $0.01. Registering gives 100 free
documents every month. An unreadable image, an empty frame or an unsupported
document type costs nothing, and every answer says whether it was billed.

[Installation](#installation) ·
[Account](#account) ·
[Nodes](#nodes) ·
[Errors](#errors) ·
[Example](#example) ·
[Resources](#resources) ·
[Version history](#version-history)

## Installation

In the Node-RED editor: **Menu → Manage palette → Install**, then search for
`@doc-cheap/node-red-doc-cheap`.

Or from your Node-RED user directory, usually `~/.node-red`:

```sh
npm install @doc-cheap/node-red-doc-cheap
```

then restart Node-RED. The nodes appear in the **doc.cheap** palette category.
They need Node-RED 3.0 or later and Node.js 18 or later, and have no runtime
dependencies.

## Account

Every node points at a **doc-cheap-config** node that holds the account:

- **API key** – a live key (`sk_live_…`) from the
  [doc.cheap cabinet](https://doc.cheap/docs/concepts/api-keys-and-sessions),
  or the public sandbox key `sk_sandbox_public` to try the nodes without an
  account. The sandbox key gives 10 free recognised documents per address in
  all, and at most 10 requests per address an hour, whatever their answer.
  The key is sent as a Bearer token. Node-RED keeps it in its credentials
  file, so it never appears in the flow JSON or in an export.
- **Base URL** – leave it at `https://api.doc.cheap`.

## Nodes

A setting on the incoming message overrides the same setting in the node's
dialog, so one node can serve messages that each ask for something different.

### recognize

Sends an image to `POST /v1/scans`.

| Input | Type | Meaning |
| --- | --- | --- |
| `msg.payload` | Buffer or string | The image (JPEG or PNG): a Buffer, a base64 string, a `data:` URL, or an `http(s)` URL that the node downloads first. Images larger than 25 MiB are refused. |
| `msg.expectCountry` | string | Optional. The country you expect, a three-letter code such as `GRC`. |
| `msg.returnPortrait` | boolean | Optional. Whether to return the holder's photo crop. |
| `msg.retainHours` | number | Optional. How many hours the result can be read back, 0 to 8760. Empty uses the account's setting. |
| `msg.reference` | string | Optional. Your own reference, up to 128 characters, echoed back. |
| `msg.idempotencyKey` | string | Optional. Sent as the `Idempotency-Key` header: sending the same key again returns the first answer instead of charging a second scan. |

Output: `msg.payload` is the scan result – `meta` (id, status, whether it was
billed, confidence), the document, the per-field readings, the
machine-readable zone and the image crops.

### get scan

Reads back a stored result with `GET /v1/scans/{id}`. The id comes from the
node's **Scan id**, then `msg.scanId`, then a string `msg.payload`. Output:
`msg.payload` is the stored scan result.

### delete scan

Deletes a stored result for good with `DELETE /v1/scans/{id}`. The id is read
the same way as in **get scan**. Output: `msg.payload` is `{ id, deleted: true }`.

### usage

Reads `GET /v1/usage`: this month's free credits, the paid credits, the credits
spent and this period's scan counters. Any message starts it. With the public
sandbox key there is no account behind the call, so the balance comes back
empty.

**Stored results.** A result is stored only when the scan was made with a live
key under a non-zero retention window, and only until that window ends. Under a
sandbox key nothing is stored, so get scan and delete scan answer "not found".
None of get scan, delete scan or usage charges a credit.

## Errors

A failed request raises a node error that a **Catch** node receives, turns the
node's status dot red and sets `msg.error` to `{ status, code, message }`:
`status` is the HTTP status (or `null` when no answer came back) and `code` is
the API's error code.

- **401 / 403** – the API key was refused.
- **429** – the rate limit was reached: try later. The key itself is fine.
- **404** – the scan does not exist, or was never stored.
- **No answer** – doc.cheap could not be reached (code `network_error`).
- **Download failed** – the image URL could not be downloaded (code
  `download_failed`).

The dot is yellow while a request runs and green when it succeeded.

## Example

**Menu → Import → Examples → @doc-cheap/node-red-doc-cheap** holds a flow with
one inject → node → debug row for each operation. It carries no API key: open
the doc.cheap account node, enter your key, and replace the example image URL
and scan id with your own.

## Resources

- [doc.cheap documentation](https://doc.cheap/docs)
- [Your first recognition](https://doc.cheap/docs/start/first-recognition)
- [From the sandbox to a live key](https://doc.cheap/docs/start/from-sandbox-to-live)
- [API reference](https://doc.cheap/docs/reference)
- [Handling errors](https://doc.cheap/docs/guides/handle-errors)

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
