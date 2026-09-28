# Discogs Music Sync to Obsidian

An Obsidian plugin that syncs folders from your Discogs collection into album notes, one note per record, and keeps a live Music Dashboard.

Each record note gets the cover and every Discogs photo, the tracklist with lengths, Genius lyrics links, label and catalogue details, your media and sleeve condition, and Discogs price data in SEK.

Plain JavaScript, no build step and no Python: `main.js`, `manifest.json` and `styles.css` are the plugin.

## Bases

A base is one folder in your Discogs collection, synced into its own folder in `Music/`, with its own tag, its own `.base` view and its own place on the dashboard. Vinyl, CDs and Tapes are set up by default.

Add, rename or stop syncing bases in **Settings → Music Library Sync → Bases**. No two bases can have the same name (ignoring case and spacing), and a name can't clash with a file or folder already in `Music/`. Adding a base creates `Music/<Name>/`, `Music/<Name>.base` and the tag `#<name>-library`, and adds the tag to `Music/All Media.base`. Stopping a base leaves its notes and `.base` file in the vault.

## Settings

- **Discogs**: username and personal access token, with a connection test.
- **Lyrics**: Genius lookup on or off, and the Genius access token.
- **Bases**: as above.
- **Sync**: download every Discogs photo, or the front cover only.
- **PDF export**: default paper size and orientation.

Tokens are saved to `Music/.discogs-token` and `Music/.genius-token`, never to the plugin's `data.json`. Keep those two files out of version control.

## Use

- **Sync from Discogs** (ribbon icon or command) adds new records and moves notes for records you've removed from Discogs into `Music/Removed from collection`. It never overwrites an existing note.
- **Refresh prices** updates only the price fields.
- **Rebuild dashboard** writes `Music/Music Dashboard.md` from `Music/.vinyl-sync/dashboard-template.md`. The dashboard needs the Dataview and Charts plugins, and takes its colours from the active theme.
- **Export dashboard as PDF** saves to `Music/Exports`.

Put a ` ```music-sync``` ` code block in any note to show the sync panel.

## Install

Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/music-library-sync/`, then enable **Music Library Sync** in Community plugins. Desktop only.
