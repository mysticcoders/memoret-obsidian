# Memoret for Obsidian

Receives end-to-end encrypted voice captures from the [Memoret](https://memoret.app) iOS and Apple Watch app and writes them into your vault as Markdown notes with the audio attached.

Memoret records and transcribes voice notes entirely on your iPhone or Apple Watch, seals each note to your vault's public key, and delivers it over your local network. This plugin is the receiver: it holds the private key, listens on your LAN, decrypts arriving captures, and files them into the vault. No third-party cloud is involved, and nothing that crosses the network is readable in transit.

## How it works

- On first load the plugin generates an X25519 keypair and stores it in the plugin's data file. The private key never leaves your desktop.
- Run the **Show pairing QR code** command and scan it with the Memoret app. The QR contains only the public key and connection details; nothing secret is displayed or transmitted.
- The plugin listens on your local network (advertised via mDNS/Bonjour) and accepts sealed capture packages, verified by bearer token and key fingerprint.
- Each capture is decrypted with libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305), validated, and written to the vault as a Markdown note with the audio file attached. Failed or malformed blobs are quarantined, never silently dropped.

## Settings

- **Note folder** and **Attachment folder** — where captures land. This vault decides, not the sending device: only the filename comes from the capture, so several paired devices no longer have to agree on a layout. Leave the folder empty to write to the vault root. Defaults are `notes` and `attachments`, matching what the app has always sent, so upgrading changes nothing.
- **Date subfolders** — optionally nest captures by `2026/07` or `2026/07/26` beneath those folders, so one directory does not grow forever.
- **Accept captures over the local network** — turn the listener and its mDNS advertisement off entirely. The inbox is still drained, so anything already delivered still arrives.
- **Port** — change it when something else already holds 41830. The port is part of the pairing payload, so re-pair your devices afterwards.
- **Check every** — seconds between inbox scans. A capture arriving over the network is ingested immediately regardless; this is the safety net.
- **Quarantined captures** — how many blobs failed to ingest, with a **Retry** button that puts them back in the inbox. Retrying is safe: anything already in the vault is recognised by its capture id and skipped.

## Where the private key lives

The receiver's private key is stored in plaintext in `<vault>/.obsidian/plugins/memoret/data.json`. Obsidian's plugin API provides no encrypted storage and no hook to create that file with restrictive permissions, so **the key is only as protected as the vault directory itself**. In practice that means:

- Anyone who can read your vault folder as your user can read the key and decrypt any capture sealed to it. Do not keep the vault on a shared drive or in a location other accounts can read.
- After each write the plugin narrows `data.json` to owner-only (`0600`) on macOS and Linux, which keeps other accounts on the machine out. Windows permissions are left to the filesystem defaults.
- Vault backups and folder-sync tools copy the key along with your notes. Treat any vault backup as key material.
- If you believe the key is exposed, delete `data.json` and reload the plugin: it generates a fresh keypair, after which you re-pair your devices. Captures already delivered stay readable; captures sealed to the old key can no longer be opened.

OS-keychain storage was evaluated and deferred. Electron's `safeStorage` is reachable from a desktop plugin through `@electron/remote`, which Obsidian initializes, but it is not part of Obsidian's documented plugin API and it does not change who can decrypt the key on a running machine: anything executing as your user — including any other installed plugin — can ask the keychain to unseal it. Its real benefit is narrower, keeping the key unreadable in vault copies such as backups and cloud-synced folders, and it is tracked as a possible future addition rather than a fix for the exposure described above.

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
