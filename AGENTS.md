# Working in Memoret for Obsidian

This plugin is a Memoret receiver: it holds the vault's private key, accepts sealed captures over the local network (`src/network.ts`) and from its iCloud Drive drop folder (`src/icloud-drop.ts`), opens them, and writes notes and audio into the vault (`src/ingest.ts`). The protocol, its vocabulary and the ingest rules are on [developer.memoret.app](https://developer.memoret.app); use the terms in [its glossary](https://developer.memoret.app/#glossary).

## The vendored contract

- `src/contract/` is a copy of the contract package from the private Memoret repository. Do not change its code here first. Change the canonical contract, then copy the files here in a matching pull request. A check in that repository fails when the two differ in code; comments may describe this plugin's context.
- A format or manifest change also needs a new tag of [memoret-contract-fixtures](https://github.com/mysticcoders/memoret-contract-fixtures); adopt it by changing the tag in `scripts/fetch-fixtures.sh`.
- The crypto is hpke-js, matching the other implementations by specification, not by shared code. Don't add native modules: the plugin must load in Obsidian's bundle without compilation.

## Rules

- The private key lives only in the plugin's `data.json`, narrowed to owner-only after each write; the README's "Where the private key lives" explains the exposure and why OS keychain storage was deferred. Never copy it into notes, logs or anywhere else, and never send it off the machine. Never log or persist plaintext captures, transcripts or pairing tokens.
- Placement is the receiver's decision: the vault folders come from settings, and the sender's manifest paths are suggestions. Follow the ingest rules on the developer site for idempotency, path safety, collisions, embed rewriting, write order, cleanup on failure and quarantine.
- Desktop only. Don't make the plugin ingest on mobile Obsidian.

## Checks

- `scripts/fetch-fixtures.sh`, then `npm ci`, `npx tsc --noEmit` and `npm test`. `npm run build` bundles `dist/main.js`. CI runs all of these on pull requests.
- Tests use fixtures and temporary folders. They do not verify a real phone, Bonjour on a real network or iCloud sync; say which evidence you have.

## Delivery

- Work on a branch and open a pull request with the problem, the change, how it was verified, and what remains.
- Pushing a tag publishes a release (`.github/workflows/release.yml`). Only tag when asked to release; keep `manifest.json` and `versions.json` in step.
