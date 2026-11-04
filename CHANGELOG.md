# Changelog

## 0.1.1

- The README and the help of the get scan, delete scan and config nodes said
  nothing is stored under a sandbox key. In fact the public sandbox key
  `sk_sandbox_public` keeps a record of every scan for one year, with a
  reduced thumbnail and the address it came from, and cannot read it back; an
  account's own sandbox key stores nothing. The text now says so, and asks for
  test images only, never a real document.

## 0.1.0

First release.

- **recognize** – recognises a passport, ID card or driving licence image given
  as a Buffer, a base64 string, a data URL or an image URL.
- **get scan** and **delete scan** for stored scan results.
- **usage** for the account's credits and scan counters.
- The **doc-cheap-config** node, which keeps the API key out of the flow JSON.
- An example flow with every operation.
