# Memoret for Obsidian

Receives end-to-end encrypted voice captures from the [Memoret](https://memoret.app) iOS and Apple Watch app and writes them into your vault as Markdown notes with the audio attached.

Memoret records and transcribes voice notes entirely on your iPhone or Apple Watch, seals each note to your vault's public key, and delivers it over your local network. This plugin is the receiver: it holds the private key, listens on your LAN, decrypts arriving captures, and files them into the vault. No third-party cloud is involved, and nothing that crosses the network is readable in transit.

## How it works

- On first load the plugin generates an X25519 keypair and stores it in the plugin's data file. The private key never leaves your desktop.
- Run the **Show pairing QR code** command and scan it with the Memoret app. The QR contains only the public key and connection details; nothing secret is displayed or transmitted.
- The plugin listens on your local network (advertised via mDNS/Bonjour) and accepts sealed capture packages, verified by bearer token and key fingerprint.
- Each capture is decrypted with libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305), validated, and written to the vault as a Markdown note with the audio file attached. Failed or malformed blobs are quarantined, never silently dropped.

## Installation

The plugin is not yet in the community plugin directory.

- **Beta (BRAT):** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin, then add `mysticcoders/memoret-obsidian` as a beta plugin.
- **Manual:** download `main.js` and `manifest.json` from the latest release into `<vault>/.obsidian/plugins/memoret/` and enable the plugin.

The plugin is desktop-only: the private key and LAN listener live on the machine that hosts your vault.

## Development

```bash
npm install
npm test
npm run build
```

The build bundles to `dist/main.js`. The Memoret delivery protocol (package format, manifest schema, sealed-box crypto) is vendored under `src/contract/`; the canonical contract lives in the main Memoret project and is kept byte-compatible with the iOS sender and the terminal receiver.

## License

[MIT](LICENSE)
