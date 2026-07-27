import { PluginSettingTab, Setting, Notice, type App } from "obsidian";
import type { DateSubfolders } from "./ingest.js";
import {
  DEFAULT_SETTINGS,
  clampNumber,
  sanitizeFolder,
  type MemoretSettings,
} from "./settings.js";

const MIN_SCAN_SECONDS = 5;
const MAX_SCAN_SECONDS = 3600;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * What the settings tab needs from the plugin, kept narrow so the tab does
 * not reach into the plugin's server or keypair internals.
 */
export interface SettingsHost {
  settings: MemoretSettings;
  saveSettings(): Promise<void>;
  restartLanServer(): void;
  rescheduleScan(): void;
  countQuarantined(): Promise<number>;
  retryQuarantined(): Promise<number>;
}

export class MemoretSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin: any,
    private host: SettingsHost,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Vault layout").setHeading();

    new Setting(containerEl)
      .setName("Note folder")
      .setDesc(
        "Where captures are written. This vault decides, not the sending device — only the filename comes from the capture. Leave empty for the vault root.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.noteFolder)
          .setValue(this.host.settings.noteFolder)
          .onChange(async (value) => {
            this.host.settings.noteFolder = sanitizeFolder(value);
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Attachment folder")
      .setDesc("Where voice recordings are written. Link captures have none.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.attachmentFolder)
          .setValue(this.host.settings.attachmentFolder)
          .onChange(async (value) => {
            this.host.settings.attachmentFolder = sanitizeFolder(value);
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Date subfolders")
      .setDesc(
        "Nest captures by date beneath those folders, so one directory does not grow forever.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("none", "None")
          .addOption("month", "Year and month (2026/07)")
          .addOption("day", "Year, month and day (2026/07/26)")
          .setValue(this.host.settings.dateSubfolders)
          .onChange(async (value) => {
            this.host.settings.dateSubfolders = value as DateSubfolders;
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl).setName("LAN receiver").setHeading();

    new Setting(containerEl)
      .setName("Accept captures over the local network")
      .setDesc(
        "Turn off to stop listening and stop advertising this vault. The inbox is still drained, so anything already delivered still arrives.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.lanEnabled).onChange(async (value) => {
          this.host.settings.lanEnabled = value;
          await this.host.saveSettings();
          this.host.restartLanServer();
        }),
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc(
        "Change this if something else already holds the default. Re-pair your devices afterwards: the port is part of the pairing payload.",
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.lanPort))
          .setValue(String(this.host.settings.lanPort))
          .onChange(async (value) => {
            this.host.settings.lanPort = clampNumber(
              value,
              DEFAULT_SETTINGS.lanPort,
              MIN_PORT,
              MAX_PORT,
            );
            await this.host.saveSettings();
            this.host.restartLanServer();
          }),
      );

    new Setting(containerEl).setName("Inbox").setHeading();

    new Setting(containerEl)
      .setName("Check every")
      .setDesc(
        `Seconds between inbox scans (${String(MIN_SCAN_SECONDS)}–${String(MAX_SCAN_SECONDS)}). A capture arriving over the network is ingested immediately regardless; this is the safety net.`,
      )
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.scanIntervalSeconds))
          .setValue(String(this.host.settings.scanIntervalSeconds))
          .onChange(async (value) => {
            this.host.settings.scanIntervalSeconds = clampNumber(
              value,
              DEFAULT_SETTINGS.scanIntervalSeconds,
              MIN_SCAN_SECONDS,
              MAX_SCAN_SECONDS,
            );
            await this.host.saveSettings();
            this.host.rescheduleScan();
          }),
      );

    void this.addQuarantineSetting(containerEl);
  }

  /**
   * Surfaces quarantined blobs, which are otherwise a console message the
   * user will never see again, and offers the one action worth taking: put
   * them back in the inbox and try once more.
   */
  private async addQuarantineSetting(containerEl: HTMLElement): Promise<void> {
    const count = await this.host.countQuarantined();
    const setting = new Setting(containerEl)
      .setName("Quarantined captures")
      .setDesc(
        count === 0
          ? "Nothing has failed to ingest."
          : `${String(count)} capture(s) could not be ingested and are held aside. Retrying is safe — anything already in the vault is recognised and skipped.`,
      );
    if (count === 0) return;
    setting.addButton((button) =>
      button
        .setButtonText("Retry")
        .setCta()
        .onClick(async () => {
          const moved = await this.host.retryQuarantined();
          new Notice(`Memoret: retrying ${String(moved)} capture(s)`);
          this.display();
        }),
    );
  }
}
