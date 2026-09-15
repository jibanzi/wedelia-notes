import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl } from 'obsidian';
import type { NotesAgentConfig, VaultReader } from './src/notesAgent.js';
import { runPollLoop } from './src/pollLoop.js';

/**
 * The Obsidian half. Everything with a decision in it lives under src/ and is
 * tested without an Obsidian runtime; this file only supplies the two seams
 * that need the real app -- listing markdown files and reading one -- plus a
 * settings pane. The package typecheck includes this adapter as well as the
 * core under src/, while the behavioural tests stay focused on the core.
 */

interface Settings extends NotesAgentConfig {
  enabled: boolean;
  /**
   * Last user-facing connection state. Technical details stay in the console;
   * the settings pane never exposes relay stages, HTTP codes or raw errors.
   */
  status?: string;
}

const DEFAULTS: Settings = {
  enabled: false,
  apiOrigin: 'https://api.wed.chat',
  username: 'wednesday',
  password: '',
  excludedFolders: [],
  status: '',
};

/**
 * Obsidian's own request API, shaped like the bit of fetch the loop uses.
 *
 * Not fetch. A renderer's fetch is subject to CORS and to Obsidian's own
 * content-security policy, and when it refuses a request it says only "Failed
 * to fetch" -- no preflight reaches the server, so there is nothing in any log
 * to look at either. requestUrl runs in the main process and has neither
 * restriction, which is why every Obsidian plugin that talks to a network uses
 * it.
 *
 * throw: false so a 401 or 204 comes back as a status instead of an exception;
 * the loop decides what each one means.
 */
const obsidianFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await requestUrl({
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    ...(init?.body === undefined ? {} : { body: init.body as string }),
    throw: false,
  });
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.json,
  };
}) as unknown as typeof fetch;

export default class WedeliaNotesPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  private running?: AbortController;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULTS, ...(await this.loadData() as Partial<Settings>) };
    this.addSettingTab(new WedeliaNotesSettingTab(this.app, this));
    if (this.settings.enabled) this.start();
  }

  onunload(): void {
    this.stop();
  }

  start(): void {
    this.stop();
    if (!this.settings.password) {
      new Notice('Wedelia: paste the connection password from the app first.');
      return;
    }
    const running = new AbortController();
    this.running = running;

    const reader: VaultReader = {
      // Paths, mtimes and the metadata cache are already in memory. Handing
      // them over costs nothing and is what lets a large vault be searched
      // without opening every file in it.
      markdownFiles: () => this.app.vault.getMarkdownFiles().map((file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        const keywords = [
          ...(cache?.headings ?? []).map((heading) => heading.heading),
          ...(cache?.tags ?? []).map((tag) => tag.tag),
          ...(Array.isArray(cache?.frontmatter?.aliases)
            ? cache.frontmatter.aliases as string[]
            : []),
        ];
        return { path: file.path, mtimeMs: file.stat.mtime, keywords };
      }),
      read: async (path) => {
        const file = this.app.vault.getFileByPath(path);
        if (!file) throw new Error('not found');
        // cachedRead: this is a read-only consumer and never wants to warm
        // the write path.
        return this.app.vault.cachedRead(file);
      },
    };

    const note = (text: string): void => {
      // Only persist a change, so a poll loop cannot rewrite data.json in a
      // tight retry.
      if (this.settings.status === text) return;
      this.settings.status = text;
      void this.saveData(this.settings);
    };

    void runPollLoop({
      reader,
      config: this.settings,
      onConnected: () => note('connected'),
      onError: (stage, detail) => {
        console.warn(`[Wedelia Notes] ${stage}: ${detail}`);
        note('needs-attention');
      },
      fetchImpl: obsidianFetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nowSeconds: () => Math.floor(Date.now() / 1_000),
      signal: running.signal,
    });
  }

  stop(): void {
    this.running?.abort();
    this.running = undefined;
  }

  async save(): Promise<void> {
    await this.saveData(this.settings);
    if (this.settings.enabled) this.start();
    else this.stop();
  }
}

class WedeliaNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: WedeliaNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('p', {
      text:
        'Lets Wedelia search this vault while she answers you. The vault is '
        + 'not uploaded or indexed. The plugin searches locally and sends '
        + 'only matching excerpts, or a note Wedelia asks to open, for the '
        + 'current request. Obsidian must stay open.',
    });

    new Setting(containerEl)
      .setName('Connection password')
      .setDesc('In Wedelia, open Privacy & data → Connect Obsidian and copy the password.')
      .addText((text) => {
        text.inputEl.type = 'password';
        return text
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value.trim();
            await this.plugin.save();
          });
      });

    new Setting(containerEl)
      .setName('Private folders (optional)')
      .setDesc('One per line. These are never searched and never sent.')
      .addTextArea((text) => text
        .setValue(this.plugin.settings.excludedFolders.join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.excludedFolders = value
            .split('\n').map((line) => line.trim()).filter(Boolean);
          await this.plugin.save();
        }));

    new Setting(containerEl)
      .setName('Let Wedelia search this vault')
      .setDesc('Keep Obsidian open while you use this connection.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.enabled)
        .onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.save();
          this.display();
        }));

    const status = !this.plugin.settings.password
      ? 'Paste the connection password above to begin.'
      : !this.plugin.settings.enabled
        ? 'Off'
        : this.plugin.settings.status === 'connected'
          ? 'Ready. Wedelia can search this vault when you ask.'
          : this.plugin.settings.status === 'needs-attention'
            ? 'Could not connect. Check the password and network; the plugin will keep trying.'
            : 'Connecting…';
    containerEl.createEl('p', { text: `Status: ${status}` });
  }
}
