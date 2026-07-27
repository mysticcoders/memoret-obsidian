import {
  FileSystemAdapter,
  Modal,
  Notice,
  Plugin,
  normalizePath,
  type App,
} from "obsidian";
import * as QRCode from "qrcode";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Bonjour } from "bonjour-service";
import {
  CAPTURE_KINDS,
  generateKeypair,
  toBase64,
  fromBase64,
  SEALED_MAGIC,
  type Keypair,
} from "./contract/index.js";
import {
  discard,
  ingestSealedBlob,
  rememberedIds,
  type Placement,
  type VaultFS,
} from "./ingest.js";
import { DEFAULT_SETTINGS, type MemoretSettings } from "./settings.js";
import { MemoretSettingTab, type SettingsHost } from "./settings-tab.js";

const INBOX_DIR = ".memoret/inbox";
const FAILED_DIR = ".memoret/failed";
const SERVICE_TYPE = "memoret";
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Bound how long a client may hold a connection. IDLE_TIMEOUT_MS drops a
// socket that stalls mid-headers or mid-body; REQUEST_TIMEOUT_MS caps a
// request that trickles bytes forever without ever idling. Node only reaps
// timed-out requests every CONNECTIONS_CHECK_MS (default 30s), so that
// interval is lowered to keep the request cap meaningful.
const IDLE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const CONNECTIONS_CHECK_MS = 5_000;
const MAX_CONNECTIONS = 16;

interface PluginData {
  publicKey: string;
  privateKey: string;
  authToken: string;
  ingested: string[];
  settings?: MemoretSettings;
}

/**
 * VaultFS backed by the Obsidian Vault API so written files are indexed
 * immediately without relying on filesystem-watch latency.
 */
class ObsidianVaultFS implements VaultFS {
  constructor(private plugin: MemoretPlugin) {}

  async exists(path: string): Promise<boolean> {
    return this.plugin.app.vault.adapter.exists(normalizePath(path));
  }

  async mkdirp(dir: string): Promise<void> {
    const segments = normalizePath(dir).split("/");
    let current = "";
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      if (!(await this.plugin.app.vault.adapter.exists(current))) {
        await this.plugin.app.vault.createFolder(current);
      }
    }
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.plugin.app.vault.create(normalizePath(path), text);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    const buffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    await this.plugin.app.vault.createBinary(normalizePath(path), buffer);
  }

  /**
   * Removes a file a failed ingest wrote. The adapter is used rather than
   * the Vault API so a path the index has not caught up with still goes.
   */
  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.plugin.app.vault.adapter.exists(normalized)) {
      await this.plugin.app.vault.adapter.remove(normalized);
    }
  }
}

/**
 * Displays the pairing payload as a scannable QR code plus a copyable JSON
 * fallback. The payload holds only the public key and delivery credentials
 * — nothing in it can decrypt captures.
 */
class PairingModal extends Modal {
  constructor(
    app: App,
    private pairingJSON: string,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.contentEl.createEl("h2", { text: "Pair a capture device" });
    this.contentEl.createEl("p", {
      text: "Scan with the Memoret iOS app. This QR contains the vault's public key and delivery token; it cannot decrypt captures.",
    });
    const dataURL = await QRCode.toDataURL(this.pairingJSON, {
      width: 360,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    const img = this.contentEl.createEl("img", { attr: { src: dataURL } });
    img.style.display = "block";
    img.style.margin = "0 auto 1em";
    const copyButton = this.contentEl.createEl("button", {
      text: "Copy pairing JSON instead",
    });
    copyButton.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.pairingJSON);
      new Notice("Memoret pairing info copied");
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
}

export default class MemoretPlugin extends Plugin implements SettingsHost {
  // Narrows the base class's own `settings?: unknown` rather than shadowing
  // it: a redeclared field would be emitted and overwrite what Obsidian put
  // there. Assigned during load, before anything reads it.
  declare settings: MemoretSettings;
  private keypair!: Keypair;
  private data!: PluginData;
  private ingested!: Set<string>;
  private scanning = false;
  private server: http.Server | null = null;
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  private scanTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadOrCreateKeypair();
    await this.ensureDir(INBOX_DIR);
    this.addSettingTab(new MemoretSettingTab(this.app, this, this));

    this.addCommand({
      id: "ingest-inbox",
      name: "Ingest inbox now",
      callback: () => void this.scanInbox(true),
    });
    this.addCommand({
      id: "copy-public-key",
      name: "Copy public key",
      callback: () => {
        void navigator.clipboard.writeText(this.data.publicKey);
        new Notice("Memoret public key copied");
      },
    });
    this.addCommand({
      id: "copy-pairing-info",
      name: "Copy pairing info (JSON)",
      callback: () => {
        void navigator.clipboard.writeText(this.pairingInfo());
        new Notice("Memoret pairing info copied");
      },
    });
    this.addCommand({
      id: "show-pairing-qr",
      name: "Show pairing QR code",
      callback: () => {
        new PairingModal(this.app, this.pairingInfo()).open();
      },
    });

    this.rescheduleScan();
    this.app.workspace.onLayoutReady(() => void this.scanInbox(false));

    this.startLanServer();
  }

  onunload(): void {
    this.stopLanServer();
  }

  /** Persists the settings alongside the keys they live beside. */
  async saveSettings(): Promise<void> {
    this.data.settings = this.settings;
    await this.persist();
  }

  /**
   * Restarts the inbox poll at the configured interval. Its own handle is
   * kept so a settings change takes effect without a plugin reload;
   * registerInterval still owns unload cleanup.
   */
  rescheduleScan(): void {
    if (this.scanTimer !== null) window.clearInterval(this.scanTimer);
    this.scanTimer = window.setInterval(
      () => void this.scanInbox(false),
      this.settings.scanIntervalSeconds * 1000,
    );
    this.registerInterval(this.scanTimer);
  }

  /** Rebinds the receiver after the port or the enable toggle changes. */
  restartLanServer(): void {
    this.stopLanServer();
    this.startLanServer();
  }

  /** How many blobs are held aside after failing to ingest. */
  async countQuarantined(): Promise<number> {
    if (!(await this.app.vault.adapter.exists(FAILED_DIR))) return 0;
    const listing = await this.app.vault.adapter.list(FAILED_DIR);
    return listing.files.filter((f) => f.endsWith(".sealed")).length;
  }

  /**
   * Moves quarantined blobs back into the inbox and drains it. Safe to
   * repeat: a capture already in the vault is recognised by its id and
   * skipped, so a retry cannot duplicate a note.
   */
  async retryQuarantined(): Promise<number> {
    if (!(await this.app.vault.adapter.exists(FAILED_DIR))) return 0;
    const listing = await this.app.vault.adapter.list(FAILED_DIR);
    const blobs = listing.files.filter((f) => f.endsWith(".sealed"));
    await this.ensureDir(INBOX_DIR);
    for (const blob of blobs) {
      const name = blob.slice(blob.lastIndexOf("/") + 1);
      await this.app.vault.adapter.rename(blob, `${INBOX_DIR}/${name}`);
    }
    void this.scanInbox(false);
    return blobs.length;
  }

  /**
   * Renders the pairing payload the QR flow (and any manual setup) uses to
   * configure a capture device in one step.
   */
  private pairingInfo(): string {
    const hostname = os.hostname().replace(/\.local$/, "");
    return JSON.stringify(
      {
        pubkey: this.data.publicKey,
        auth_token: this.data.authToken,
        lan_hostname: hostname,
        lan_port: this.settings.lanPort,
        label: `Obsidian (${hostname})`,
      },
      null,
      2,
    );
  }

  /**
   * Binds the LAN receiver and advertises it over mDNS so capture devices
   * can discover the vault without manual IP entry.
   */
  private startLanServer(): void {
    if (!this.settings.lanEnabled) {
      console.log("Memoret: LAN receiver disabled in settings");
      return;
    }
    const port = this.settings.lanPort;
    const server = http.createServer(
      {
        connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
        headersTimeout: HEADERS_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      },
      (req, res) => {
        void this.handleRequest(req, res);
      },
    );
    server.maxConnections = MAX_CONNECTIONS;
    server.setTimeout(IDLE_TIMEOUT_MS);
    server.on("timeout", (socket) => socket.destroy());
    server.on("error", (err: NodeJS.ErrnoException) => {
      console.error("Memoret: LAN server error", err);
      new Notice(
        err.code === "EADDRINUSE"
          ? `Memoret: port ${String(port)} is already in use — change it in Memoret settings`
          : "Memoret: LAN server error (see console)",
      );
    });
    server.listen(port, "0.0.0.0", () => {
      this.bonjour = new Bonjour();
      this.bonjour.publish({
        name: `Memoret (${os.hostname()})`,
        type: SERVICE_TYPE,
        port,
      });
      console.log(
        `Memoret: LAN receiver on :${String(port)}, advertising _${SERVICE_TYPE}._tcp`,
      );
    });
    this.server = server;
  }

  /**
   * Tears down the socket and the mDNS advertisement so a plugin reload or
   * disable can rebind cleanly.
   */
  private stopLanServer(): void {
    this.bonjour?.unpublishAll();
    this.bonjour?.destroy();
    this.bonjour = null;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  /**
   * Compares the presented bearer token against the stored one in constant
   * time.
   */
  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const presented = Buffer.from(header.replace(/^Bearer /, ""));
    const expected = Buffer.from(this.data.authToken);
    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  }

  /**
   * Routes LAN requests: GET /ping for reachability checks and POST
   * /capture to accept a sealed blob into the inbox.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const respond = (status: number, body: object): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/ping") {
        const fingerprint = createHash("sha256")
          .update(Buffer.from(this.data.publicKey, "base64"))
          .digest("hex")
          .slice(0, 16);
        return respond(200, {
          service: "memoret",
          version: this.manifest.version,
          fingerprint,
          // Comma-separated rather than a JSON array on purpose: shipped
          // senders decode /ping as a flat string map, and an array value
          // makes that decode throw, which would look like the receiver had
          // vanished. Senders that do not know the field read this receiver
          // as voice-only.
          capabilities: CAPTURE_KINDS.join(","),
        });
      }
      if (req.method === "POST" && req.url === "/capture") {
        if (!this.authorized(req)) {
          return respond(401, { error: "unauthorized" });
        }
        const blob = await this.readBody(req);
        if (
          blob.length < SEALED_MAGIC.length ||
          !SEALED_MAGIC.every((b, i) => blob[i] === b)
        ) {
          return respond(400, { error: "not a VVSB sealed blob" });
        }
        const name = `lan-${Date.now()}-${randomBytes(4).toString("hex")}.sealed`;
        await this.ensureDir(INBOX_DIR);
        await this.app.vault.adapter.writeBinary(
          `${INBOX_DIR}/${name}`,
          blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer,
        );
        respond(202, { stored: name });
        void this.scanInbox(false);
        return;
      }
      respond(404, { error: "not found" });
    } catch (err) {
      console.error("Memoret: LAN request failed", err);
      respond(err instanceof BodyTooLargeError ? 413 : 500, {
        error: err instanceof Error ? err.message : "internal error",
      });
    }
  }

  /**
   * Collects a request body up to the size cap, rejecting oversized
   * uploads before they buffer unbounded memory.
   */
  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          req.destroy();
          reject(new BodyTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  /**
   * Persists plugin data and then restricts the data file to the owner.
   * The Obsidian API offers no hook to create it with a mode, so the
   * narrowing happens immediately after the write — it keeps other accounts
   * on the machine out of the private key, but anyone who can read the
   * vault directory as this user can still read it.
   */
  private async persist(): Promise<void> {
    await this.saveData(this.data);
    if (process.platform === "win32") return;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const dataPath = path.join(
      adapter.getBasePath(),
      this.manifest.dir ?? "",
      "data.json",
    );
    try {
      await fs.chmod(dataPath, 0o600);
    } catch (err) {
      console.error("Memoret: could not restrict data.json permissions", err);
    }
  }

  /**
   * Loads the persisted keypair or generates one on first run, keeping the
   * private key inside the plugin's data.json on the desktop host.
   */
  private async loadOrCreateKeypair(): Promise<void> {
    const stored = (await this.loadData()) as PluginData | null;
    // Merged field by field rather than wholesale, so a setting added in a
    // later release gets its default instead of being undefined for anyone
    // whose data.json predates it.
    this.settings = { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) };
    if (stored?.privateKey) {
      this.data = {
        ...stored,
        ingested: stored.ingested ?? [],
        authToken: stored.authToken ?? randomBytes(32).toString("base64url"),
        settings: this.settings,
      };
      if (!stored.authToken) await this.persist();
    } else {
      const kp = await generateKeypair();
      this.data = {
        publicKey: await toBase64(kp.publicKey),
        privateKey: await toBase64(kp.privateKey),
        authToken: randomBytes(32).toString("base64url"),
        ingested: [],
        settings: this.settings,
      };
      await this.persist();
      new Notice("Memoret: generated new keypair — pair your device");
    }
    this.keypair = {
      publicKey: await fromBase64(this.data.publicKey),
      privateKey: await fromBase64(this.data.privateKey),
    };
    this.ingested = new Set(this.data.ingested);
  }

  /**
   * Creates a hidden directory via the adapter, which keeps it out of the
   * vault index while remaining readable by the plugin.
   */
  private async ensureDir(dir: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  /**
   * Drains the inbox: each sealed blob is decrypted and written into the
   * vault, then deleted; blobs that fail are moved aside so one bad file
   * cannot wedge the loop.
   */
  private async scanInbox(interactive: boolean): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const listing = await this.app.vault.adapter.list(INBOX_DIR);
      const blobs = listing.files.filter((f) => f.endsWith(".sealed"));
      if (blobs.length === 0) {
        if (interactive) new Notice("Memoret: inbox empty");
        return;
      }
      const fs = new ObsidianVaultFS(this);
      for (const path of blobs) {
        await this.ingestOne(path, fs);
      }
    } catch (err) {
      console.error("Memoret: inbox scan failed", err);
      if (interactive) new Notice("Memoret: inbox scan failed (see console)");
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Ingests a single sealed blob file, recording the capture id and
   * deleting the blob on success or quarantining it on failure.
   */
  private async ingestOne(path: string, fs: VaultFS): Promise<void> {
    try {
      const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
      const placement: Placement = {
        noteFolder: this.settings.noteFolder,
        attachmentFolder: this.settings.attachmentFolder,
        dateSubfolders: this.settings.dateSubfolders,
      };
      const result = await ingestSealedBlob(
        bytes,
        this.keypair,
        fs,
        this.ingested,
        placement,
      );
      if (!result.duplicate) {
        // Recorded only once the files are down. The other order would lose
        // a capture outright if the write then failed, and a capture
        // arriving twice is a far better failure than one that never
        // arrives. If recording it fails, what was written is taken back so
        // the retry does not land a second copy alongside the first.
        try {
          this.ingested.add(result.captureId);
          this.data.ingested = rememberedIds(this.ingested);
          // Kept in agreement with what was stored, so a long-running
          // session does not answer differently from a fresh launch.
          if (this.data.ingested.length < this.ingested.size) {
            this.ingested = new Set(this.data.ingested);
          }
          await this.persist();
        } catch (err) {
          this.ingested.delete(result.captureId);
          await discard(
            fs,
            [result.notePath, result.audioPath].filter(
              (p): p is string => p !== undefined,
            ),
          );
          throw err;
        }
        new Notice(`Memoret: captured ${result.notePath}`);
      }
      await this.app.vault.adapter.remove(path);
    } catch (err) {
      console.error(`Memoret: failed to ingest ${path}`, err);
      await this.ensureDir(FAILED_DIR);
      const name = path.slice(path.lastIndexOf("/") + 1);
      await this.app.vault.adapter.rename(path, `${FAILED_DIR}/${name}`);
      new Notice(`Memoret: quarantined ${name} (see console)`);
    }
  }
}
