# Discogs music sync and Dashboard

An Obsidian plugin that turns your Discogs collection into a music library in your vault: one note per record, a `.base` view for each collection, and a live Music Dashboard.

The repository is *Discogs Music Sync to Obsidian*. The plugin's ID, and its folder in `.obsidian/plugins/`, is `music-library-sync`.

## Features

- **One note per record.** Each note gets the front cover and every other Discogs photo, the tracklist with track lengths, label, catalogue number, country, format, genres and styles, your media and sleeve condition, and Discogs price data in SEK.
- **Genius lyrics links.** Each track links to its lyrics on Genius where a match is found.
- **Bases.** Each folder in your Discogs collection (Vinyl, CDs, Tapes, or any others you add) syncs into its own folder with its own tag and `.base` view, and appears on the dashboard. You can add, rename and remove bases in settings.
- **Safe syncing.** A sync only adds records. It never overwrites a note you've edited. Records you remove from Discogs are moved to `Music/Removed from collection`, never deleted.
- **Price refresh.** Updates only the price fields on every record, leaving everything else alone.
- **Music Dashboard.** Record counts, playing time, what the collection is worth, the most valuable records, genres, styles, decades, top artists, buying history, and a list of new records you haven't listened to yet. It is coloured by your active Obsidian theme.
- **PDF export.** Saves the dashboard as a PDF in the paper size and orientation you choose.
- **Sync panel.** Buttons, progress and a log, in any note, through a `music-sync` code block.

## Requirements

- Obsidian 1.4 or later, desktop only (macOS, Windows or Linux).
- A Discogs account and a personal access token.
- For the dashboard: the **Dataview** community plugin (with JavaScript queries enabled) and the **Charts** community plugin.
- Optional: a Genius API access token, for lyrics links.

No Python or other tools are needed. The plugin is plain JavaScript with no build step.

## Installation

1. Create the folder `<your vault>/.obsidian/plugins/music-library-sync/`.
2. Copy `main.js`, `manifest.json`, `styles.css` and `dashboard-template.md` from this repository into it.
3. In Obsidian, open **Settings → Community plugins**, reload the list and enable **Discogs music sync and Dashboard**.

## Quick start

1. Open **Settings → Discogs music sync and Dashboard**.
2. Enter your Discogs username, paste your personal access token and press **Test**.
3. Check that the three default bases (Vinyl, CDs and Tapes) point at the right Discogs folders, or add your own.
4. Press the disc icon in the ribbon, or run **Sync from Discogs** from the command palette.
5. Open `Music/Music Dashboard.md`.

The [User Guide](User%20Guide.md) covers every feature and setting in detail.

## Privacy and security

- The plugin talks only to `api.discogs.com` and `api.genius.com`, and only when you start a sync, a price refresh, a dashboard rebuild or a connection test.
- Tokens are stored in `Music/.discogs-token` and `Music/.genius-token` in your vault, never in the plugin's `data.json`. If your vault is in git, add both files to `.gitignore`.
- Nothing is sent anywhere else, and there is no telemetry.

## Known limitations

- Prices are in Swedish kronor (SEK).
- Discogs price suggestions (the Low, Mid, High and Mint estimates) only appear once your Discogs Seller Settings are filled in. Without them, the dashboard uses the cheapest current listing instead.
- The Music folder is fixed at `Music/` in the root of the vault.
- Renaming a base renames its `.base` file, but its notes stay in their original folder.
- Desktop only, because PDF export uses Electron.

## Feedback

Use **Report a bug** or **Request a feature** at the bottom of the plugin's settings page. They open this repository's issue forms, which label the issue `bug` or `enhancement` automatically.

## License

MIT. See [LICENSE](LICENSE).

Created by Anthony Fitzpatrick, Wolf 359 Press AB.
