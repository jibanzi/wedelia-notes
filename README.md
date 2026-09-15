# Wedelia Notes

Lets [Wedelia](https://wed.chat), an AI companion app, search your Obsidian
vault while she answers you.

You ask Wedelia something. If your notes might help, she asks this plugin, the
plugin searches the vault on your computer, and only what matched is sent back.

## What leaves your device

- **A search** sends up to 5 matching excerpts, each at most 400 characters,
  with the path of the note it came from.
- **Opening a note** sends that one note, capped at 40,000 characters. Wedelia
  can only open notes you share (see below), and asking for a note you don't
  share gets the same answer as asking for one that doesn't exist.
- Nothing else. The vault is not uploaded, not indexed on a server, and there
  is no copy of it anywhere else.

The honest caveat: whatever is sent travels with that one request, so the AI
model provider handling the request sees it, the same as the rest of your
message. "Not stored" is true. "Never leaves your machine" would not be.

It only works while Obsidian is open. When it is closed, Wedelia is told your
notes are unreachable and says so rather than guessing.

## Never searched or opened

- What Wedelia's own vault mirror writes into your vault: the top-level
  `Memories/`, `Diary/`, `People/` and `Itineraries/` folders, and `Tasks.md`
  and `README.md` at the vault root. Otherwise she would read her exported
  memories back as if you had written them.
- `.obsidian/` and anything else whose path starts with a dot
- Any folder you list under **Private folders**

## Requirements and disclosures

- **Account:** requires a Wedelia account. The connection password comes from
  the Wedelia app.
- **Network use:**
  - `api.wed.chat` exchanges your connection password for a short-lived ticket.
  - The Wedelia notes relay (hosted on Google Cloud, its address comes with the
    ticket) receives Wedelia's search requests; the plugin holds a request open
    to pick them up and posts back the results.
- **No telemetry:** the plugin sends nothing beyond the above. How Wedelia
  handles your data is described in its
  [privacy policy](https://wed.chat/privacy).
- **Closed-source service:** this plugin is MIT-licensed. The Wedelia app, API
  and relay it connects to are not open source.
- The plugin never modifies your notes and never touches files outside your
  vault.

## Install

**From Obsidian:** open **Settings → Community plugins → Browse** and search
for "Wedelia Notes", or open its
[directory page](https://community.obsidian.md/plugins/wedelia-notes) and
select **Add to Obsidian**.

**Manually:** download `main.js` and `manifest.json` from the
[latest release](https://github.com/jibanzi/wedelia-notes/releases/latest) into
`<your vault>/.obsidian/plugins/wedelia-notes/`, reload Obsidian, and enable
**Wedelia Notes** under **Community plugins**.

## Set up

1. In the Wedelia app, open **Privacy & data → Connect Obsidian** and copy the
   connection password.
2. In Obsidian, open **Settings → Wedelia Notes** and paste it.
3. Optionally list folders to keep private, one per line.
4. Turn on **Let Wedelia search this vault**. The status reads **Ready** once
   it has connected.

## Large vaults

Search never reads the whole vault. Obsidian already holds every path, mtime
and heading in memory, so names, headings, tags and aliases are matched for
free, and only the notes that matched get opened. When nothing matches for
free it falls back to reading the 400 most recently modified notes, and the
whole thing stops at an 8-second budget regardless: the request it answers
lives 18 seconds, and answering late is the one failure it cannot have.

Measured on a 49,802-note, 60.8 MB vault: reading everything took 17.1s. That
was never going to fit.

The ceiling this buys: a term that appears only in the body of an old note,
whose name and headings never mention it, is not found. A real index is the
upgrade, not a bigger scan. This is the best place to help.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
node test/bundle.smoke.cjs
```

- `src/` has everything with a decision in it, tested without an Obsidian
  runtime.
- `main.ts` is the Obsidian adapter: list files, read a file, settings pane.
- `test/fixtures/relay-envelopes.json` holds envelopes produced by the Wedelia
  relay. The relay only accepts a result that matches exactly, so the tests
  check the plugin builds the same bytes.
- `npm run package` builds a zip with a ready-to-copy `wedelia-notes/` folder.
- Releases are cut by pushing a tag equal to the `manifest.json` version. The
  release workflow builds, tests, attests and publishes `main.js` and
  `manifest.json`, so release assets are never built on a laptop.

`npm run build` also writes `dist/package.json` marking the bundle as
CommonJS. Obsidian evaluates it that way regardless, but without it Node reads
the `.js` extension as ESM and the smoke test cannot load the bundle. An ESM
bundle would load in Obsidian as an empty module with no error at all, which
looks exactly like a plugin that installed fine and does nothing.

## Contributing

Issues and pull requests are welcome. The relay protocol is set by the Wedelia
service, which is not in this repository, so a change to the envelope format
can't be accepted here on its own.

## License

[MIT](LICENSE)
