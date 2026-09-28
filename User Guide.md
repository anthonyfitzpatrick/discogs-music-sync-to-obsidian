# Discogs music sync and dashboard User Guide

Discogs music sync and dashboard (repository: *Discogs Music Sync to Obsidian*, plugin ID `music-library-sync`) turns your Discogs collection into a music library inside your Obsidian vault. This guide explains how to set it up and how to use each part of it.

## Contents

1. [About Discogs music sync and dashboard](#1-about-music-library-sync)
2. [Requirements](#2-requirements)
3. [Installation](#3-installation)
4. [First-time setup](#4-first-time-setup)
5. [The settings page](#5-the-settings-page)
6. [Bases](#6-bases)
7. [Syncing from Discogs](#7-syncing-from-discogs)
8. [Record notes](#8-record-notes)
9. [Prices](#9-prices)
10. [The sync panel](#10-the-sync-panel)
11. [The Music Dashboard](#11-the-music-dashboard)
12. [Exporting the dashboard as a PDF](#12-exporting-the-dashboard-as-a-pdf)
13. [Commands](#13-commands)
14. [Files and folders](#14-files-and-folders)
15. [Privacy and security](#15-privacy-and-security)
16. [Troubleshooting](#16-troubleshooting)
17. [Frequently asked questions](#17-frequently-asked-questions)
18. [Getting help](#18-getting-help)

## 1. About Discogs music sync and dashboard

Discogs is where you catalogue the records you own. Discogs music sync and dashboard brings that catalogue into Obsidian, where you can annotate it, link it and see it at a glance.

For every record in your Discogs collection, the plugin creates a note with:

- the front cover, plus every other photo Discogs has (back cover, labels, inserts),
- the full tracklist, with track lengths and links to lyrics on Genius,
- label, catalogue number, country, format, release year and original release year,
- genres and styles,
- your media and sleeve condition, and your notes, from Discogs,
- current Discogs prices in Swedish kronor.

Records are grouped into **bases**, one per Discogs collection folder: by default **Vinyl**, **CDs** and **Tapes**. Each base has its own folder, tag and Obsidian `.base` view, and the **Music Dashboard** brings them all together.

The plugin is careful with your notes:

- A sync only **adds** records. It never overwrites a note that already exists, so anything you write in a record note is safe.
- **Refresh prices** changes only the price fields.
- When you remove a record from Discogs, its note is **moved** to `Music/Removed from collection`, never deleted.

## 2. Requirements

| Requirement | Why |
|---|---|
| Obsidian 1.9 or later, on desktop (macOS, Windows or Linux) | The `.base` views need Obsidian's Bases feature, and the plugin and its PDF export run on desktop only. |
| A Discogs account with your records in your collection | This is where the records come from. |
| A Discogs personal access token | Lets the plugin read your collection and prices. |
| The **Dataview** community plugin, with **Enable JavaScript Queries** turned on | Draws the Music Dashboard. |
| The **Charts** community plugin | Draws the dashboard's charts. |
| A Genius API access token (optional) | Adds lyrics links to tracklists. |

Without Dataview and Charts, syncing and PDF export still work; only the live dashboard note is affected. Without a Genius token, notes simply have no lyrics links.

## 3. Installation

### 3.1 From a release

1. Open the [latest release](https://github.com/anthonyfitzpatrick/discogs-music-sync-to-obsidian/releases/latest) and download `main.js`, `manifest.json` and `styles.css`.
2. Create the folder `<your vault>/.obsidian/plugins/music-library-sync/` and put the three files in it.
3. Open **Settings → Community plugins**. If Restricted mode is on, turn it off.
4. Reload the list of installed plugins and turn on **Discogs music sync and dashboard**.

To update, replace the three files with those from the newer release and turn the plugin off and on again (or restart Obsidian).

### 3.2 With BRAT

BRAT is a community plugin for installing plugins that aren't in the community list yet, and keeping them updated.

1. Install and enable **BRAT** from **Settings → Community plugins → Browse**.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Enter `anthonyfitzpatrick/discogs-music-sync-to-obsidian` and confirm.
4. Turn on **Discogs music sync and dashboard** in **Settings → Community plugins**.

BRAT checks for new releases when Obsidian starts.

## 4. First-time setup

### 4.1 Get a Discogs token

1. Sign in at [discogs.com](https://www.discogs.com).
2. Go to **Settings → Developers**.
3. Press **Generate new token** and copy it.

The token gives read access to your account. Treat it like a password.

### 4.2 Get a Genius token (optional)

1. Sign in at [genius.com](https://genius.com) and open [genius.com/api-clients](https://genius.com/api-clients).
2. Create an API client. Any name and website address will do.
3. Press **Generate Access Token** and copy the token.

### 4.3 Enter them in Obsidian

1. Open **Settings → Discogs music sync and dashboard**. Until setup is done, the top of the page shows a **Getting started** list, and ticks off each step as you finish it.
2. Under **Discogs**, type your Discogs **Username**.
3. Paste your Discogs token into **Personal access token** and press Enter or click elsewhere. The description changes to "A token is saved."
4. Press **Test**. You should see "Connected as *your name*".
5. Under **Lyrics**, paste your Genius token into **Genius access token** and press **Test**.

### 4.4 Set up your bases

Every record on Discogs has a format, such as Vinyl, CD or Cassette. The plugin puts each record in the base for its format, automatically: you don't have to sort your collection into folders on Discogs.

1. Under **Bases**, press **Set up from Discogs**. The button works once your username and token are saved.
2. The dialog reads your collection and lists every format in it, with how many records have each. All are ticked; untick any you don't want.
3. Press **Add bases**.

Each ticked format becomes a base with the format's name, for example `Vinyl` becomes `Music/Vinyl/`, `Music/Vinyl.base` and the tag `#vinyl-library`, with an icon to match. You can rename bases afterwards (see [6.3](#63-editing-and-renaming-a-base)), or add more with **Add base** (see [6.2](#62-adding-a-base)).

### 4.5 Check the dashboard plugins

Under **Dashboard**, the settings page says whether the plugins the Music Dashboard needs are ready: Dataview, with **Enable JavaScript Queries** turned on, and Charts. If something is missing, it says what to install or turn on.

### 4.6 Run the first sync

Run **Discogs music sync and dashboard: Sync from Discogs** from the command palette. (The disc icon in the ribbon opens the Music Dashboard, which has a **Sync from Discogs** button at the top.)

The first sync can take a while. Discogs allows about one request a second, and each record needs several requests: the release, its master, prices, cover and photos. Expect roughly 5 to 15 seconds per record, plus time for Genius lookups. A collection of 150 records takes about half an hour. Later syncs only fetch new records, so they are quick.

You can keep working in Obsidian while it runs. To follow progress, add the sync panel to a note (see [section 10](#10-the-sync-panel)); the Music Dashboard already has one at the top.

## 5. The settings page

Open **Settings → Discogs music sync and dashboard**. Changes are saved as you make them and apply from the next sync.

### 5.1 Discogs

- **Username**: the Discogs account whose collection is synced.
- **Personal access token**: paste a token and press Enter to save it. The field is masked and always shows empty; the description says whether a token is saved. Paste a new token at any time to replace it.
- **Test**: checks the saved token with Discogs.
  - "Connected as *name*" means everything is fine.
  - "The token belongs to *X*, but the username above is *Y*" means the token and username don't match. Syncing uses the username, so fix whichever is wrong.
  - "Discogs didn't accept the token" means the token is wrong or has been revoked. Generate a new one.
  - If the username is empty when you test, it is filled in from the token.

### 5.2 Lyrics

- **Add Genius lyrics links**: when on, each track of a newly added record is looked up on Genius. Turn it off to make syncing faster.
- **Genius access token** and **Test**: work the same way as the Discogs token.

### 5.3 Bases

Lists every base with its icon, name, formats, vault folder and tag.

- The **pencil** button edits or renames the base.
- The **bin** button stops syncing it.
- **Set up from Discogs** adds bases for formats in your collection that don't have one yet.
- **Add base** creates a new one by hand.

See [section 6](#6-bases).

### 5.4 Dashboard

Says whether Dataview (with JavaScript queries) and Charts are enabled, and what to do if not, with a button to open the Music Dashboard.

### 5.5 Sync

- **Download all images**: when on, every Discogs photo of a new record is saved and shown under **Images** in its note. When off, only the front cover is downloaded, which makes syncing faster and uses less space.

### 5.6 PDF export

- **Paper size**: A5, A4, A3, Letter, Legal or Tabloid.
- **Orientation**: Portrait or Landscape.

These are the defaults for the export dialog. Whatever you pick in the dialog is also remembered here.

### 5.7 About

The bottom of the page shows the plugin's version, and buttons to report a bug, request a feature, and visit the author's and Wolf 359 Press's websites. See [section 18](#18-getting-help).

## 6. Bases

### 6.1 What a base is

A base takes every record of the formats you choose, from anywhere in your Discogs collection, into:

- its own **vault folder** inside `Music/`, which holds its record notes, a `covers/` folder and an `images/` folder,
- its own **tag**, such as `#vinyl-library`, which every record note in it carries,
- its own **`.base` file**, such as `Music/Vinyl.base`, an Obsidian Bases view with the views listed below,
- its own entry in **`Music/All Media.base`**, which shows every base together,
- its own colour and rows on the **Music Dashboard**.

### How records find their base

- Each base takes one or more **formats**, as Discogs names them: for example Vinyl takes `Vinyl`, and CDs might take `CD` and `CDr`.
- Formats are **chosen from the formats in your collection, never typed**, so a misspelling can't send records nowhere.
- Each format belongs to **one base only**.
- A record with several formats goes to the base of the **first** of them that has one, in the order Discogs lists them. A box set listed as *Box Set, Vinyl* goes to your Vinyl base, unless you have a base for Box Set.
- A record whose formats have **no base** isn't synced, and every sync says so in the log and the summary, so nothing is left out without you knowing.

Every `.base` file has these views:

| View | Shows |
|---|---|
| Gallery | Cover art cards, sorted by artist and year |
| By genre | Cover art cards grouped by genre |
| Catalogue | A table of the catalogue details, condition, purchase details and whether it's ripped |
| Value | A table of every price field, most valuable first |
| Not ripped yet | Cover art cards of records whose `ripped` is not ticked |

### 6.2 Adding a base

Say you've started collecting MiniDiscs and added some to your Discogs collection.

1. Open **Settings → Discogs music sync and dashboard** and press **Add base**, or run **Discogs music sync and dashboard: Add a base…**.
2. Enter a **Name**, for example `MiniDiscs`. This becomes the folder name, the `.base` file name and the name on the dashboard.
3. Under **Formats**, turn on the formats the base takes, for example `Minidisc`. The dialog lists every format in your collection with its record count; formats another base already takes are shown as taken and can't be turned on. If your collection can't be read, formats can't be chosen: check your username and token with **Test**.
4. Choose an **Icon**. It is shown in the settings list and in the sync progress.
5. The dialog shows what it will create, for example: *Creates Music/MiniDiscs/, Music/MiniDiscs.base and the tag #minidiscs-library.*
6. Press **Add base**.

The folder and `.base` file are created straight away, and the base's tag is added to `Music/All Media.base` (which is created if it doesn't exist). The next sync fills the base with records.

If a base's folder or `.base` file goes missing later, the next sync creates it again. Files that exist are never changed, so your own edits to a `.base` file are kept.

### 6.3 Editing and renaming a base

Press the pencil next to a base. You can change:

- **Name**: renames the base on the dashboard and renames its `.base` file. Links to the `.base` file are updated. The notes stay where they are, and the tag doesn't change.
- **Formats**: which formats the base takes. When you change them, the next sync moves any record whose format now belongs to a different base.
- **Icon**.

### 6.4 Name rules

Each base must have its own name. The **Add base** and **Save** buttons stay disabled, and the dialog explains why, when:

- **another base already has that name.** Capitals and extra spaces don't count, so `vinyl`, `VINYL` and `  Vinyl ` are all the same as `Vinyl`.
- **the name is too close to another base's.** Names that differ only in punctuation or spacing, such as `Mini Disc` and `Mini-Disc`, would produce the same tag.
- **no format is chosen**, or **a chosen format already belongs to another base**. Each format can belong to only one base.
- **`Music/` already has a file or folder with that name**, such as `Exports`, `Removed from collection` or `All Media`.
- **the name contains a character that isn't allowed in file names** (`\ / : * ? " < > | # ^ [ ]`), or starts with a dot.
- the name is empty, has no letters or numbers, or is longer than 60 characters.

### 6.5 Removing a base

Press the bin next to a base and confirm. The base stops syncing and disappears from the dashboard.

Its folder, notes and `.base` file stay in your vault, and its tag stays in `All Media.base`. Delete them yourself if you no longer want them. Because the folder still exists, you can't add a new base with the same name until you rename or delete it.

You can remove every base. The dashboard then says there are no bases to show, and a sync asks you to add one.

## 7. Syncing from Discogs

Start a sync with the **Sync from Discogs** command, or the **Sync from Discogs** button on the sync panel (at the top of the Music Dashboard).

A sync:

1. reads your whole Discogs collection, every folder and every page,
2. puts each record in the base for its format (see [6.1](#61-what-a-base-is)), and reports records whose format has no base, and bases whose formats no record has,
3. finds every existing record note, in every base, matching on each note's `discogs_instance`,
4. moves notes of records that have left your collection (see [7.2](#72-records-you-remove-from-discogs)),
5. moves notes that are in the wrong base, for example after you change a base's formats (see [7.3](#73-records-in-the-wrong-base)),
6. creates a note for each new record, base by base (see [section 8](#8-record-notes)),
7. rebuilds the Music Dashboard.

The summary at the end says how many records were added, moved and removed, and how many have no base.

### 7.1 Records you add

Each new record gets a note named `Artist - Title.md` in its base's folder. Characters that aren't allowed in file names are removed, and names are cut at 150 characters. If a note with that name already exists (for example, two pressings of the same album), the new one is called `Artist - Title (2).md`.

The same album can be in your collection more than once; each copy gets its own note.

### 7.2 Records you remove from Discogs

If a record is no longer anywhere in your Discogs collection, its note is moved to `Music/Removed from collection`. Its tag is changed to `#removed-from-collection` and a `removed_from_collection` date is added, so it drops out of the bases and the dashboard but keeps everything you wrote in it.

Moving a record between folders on Discogs changes nothing: folders don't decide where records go.

Nothing is ever deleted.

### 7.3 Records in the wrong base

If a record's note is in one base but its format belongs to another (because you changed a base's formats, or the record's format was corrected on Discogs), the note is moved to the right base's folder and its tag is changed to match. Everything you wrote in the note is kept. The sync log lists each move.

### 7.4 Cancelling

Press **Cancel** on the sync panel, or run **Cancel running sync**. The plugin finishes the record it is working on and then stops. Records already added are kept, and the next sync carries on from where this one stopped.

### 7.5 When Discogs or Genius is slow

The plugin waits between requests to stay within Discogs' limits. If Discogs is busy (HTTP 429 or a server error), it waits 15 seconds and tries again, up to five times. If a request gets no answer within 30 seconds, it retries. Each wait is noted in the sync log.

A failed cover or photo download doesn't stop the sync; the note is created without that image and the failure is logged.

## 8. Record notes

### 8.1 What's in a note

```
---
artist: "1927"
title: "...Ish"
year: 1988
...
---
# 1927 – ...Ish

![cover]

## Tracklist
| # | Title | Length | Lyrics |

## Images
(every Discogs photo)

## Notes
(your Discogs notes for this copy, if any)
```

Write anything you like under **Notes**, or anywhere else in the note. A sync never overwrites the note, and a price refresh only changes the price fields.

### 8.2 Properties

**Filled in from Discogs:**

| Property | Contents |
|---|---|
| `artist` | Artist name(s), as credited |
| `title` | Album title |
| `year` | Year of this release |
| `original_year` | Year of the first release (from the Discogs master release) |
| `genres`, `styles` | Discogs genres and styles |
| `label`, `catno`, `country` | Label, catalogue number and country of this release |
| `format` | Full format, for example "1x Vinyl, LP, Album, Stereo" |
| `media` | Discogs' format name, for example "Vinyl" or "CD" |
| `cover` | Link to the front cover image |
| `media_condition`, `sleeve_condition` | Your grading, from your Discogs collection |
| `added_to_discogs` | When you added the record to Discogs |
| `discogs_id`, `discogs_instance`, `discogs_url` | Identify the release and your copy of it. Don't edit these; the sync uses `discogs_instance` to recognise the note. |
| Price fields | See [section 9](#9-prices) |

**For you to fill in:**

| Property | Use |
|---|---|
| `purchased` | Date you bought it. The dashboard's buying charts use this, falling back to `added_to_discogs`. |
| `shop` | Where you bought it. Feeds the dashboard's "Where you buy" chart. |
| `price_paid_sek` | What you paid |
| `ripped` | Tick once you've digitised it. Feeds the "Ripped" column and the "Not ripped yet" view. |
| `listened` | Ticked for you when you tick the record on the dashboard's "not listened to yet" list, which also adds `listened_on`. |

### 8.3 Tracklist

Each row shows the position (A1, B2, 1…), title, length and a **Lyrics** link.

- Track lengths come from the release. Where it has none, they are taken from the Discogs master release or its main release.
- Headings (for example "Side A") and index tracks with sub-tracks are shown in bold.
- A lyrics link is added only when Genius has a song whose title and artist match. Tracks credited to other artists are matched on their own artist, and cast recordings and soundtracks are matched on the album. Instrumentals and obscure tracks often have no link.
- Lyrics are looked up only when the note is created. Turning lyrics on later doesn't add links to existing notes.

### 8.4 Images

Covers are saved in `<base folder>/covers/`, named after the Discogs release ID. Other photos are saved in `<base folder>/images/`, numbered `-01`, `-02` and so on. Images already on disk are never downloaded again.

## 9. Prices

All prices are in Swedish kronor, rounded to whole kronor.

| Property | Meaning |
|---|---|
| `market_lowest_sek` | The cheapest copy of this release currently for sale on Discogs |
| `market_for_sale` | How many copies are for sale |
| `price_low_sek` | Discogs' suggested price in Good Plus (G+) condition |
| `price_mid_sek` | Suggested price in Very Good Plus (VG+) condition |
| `price_high_sek` | Suggested price in Near Mint (NM or M-) condition |
| `price_max_sek` | Suggested price in Mint (M) condition |
| `price_my_copy_sek` | Suggested price for the condition you gave your copy |
| `price_checked` | When the prices were last fetched |

**Price suggestions need Discogs Seller Settings.** Discogs only gives price suggestions to accounts whose Seller Settings are filled in (you don't have to sell anything). Until then, the suggestion fields stay empty, the log says "price suggestions need Discogs Seller Settings", and the dashboard values records by their cheapest listing instead.

**Refresh prices** (button or command) fetches new prices for every record in every base and rewrites only the price fields. It takes about two seconds per record. Records without a `discogs_id` are skipped. When it finishes, it rebuilds the dashboard.

## 10. The sync panel

Add this to any note to get the sync panel:

````
```music-sync
```
````

The Music Dashboard already has one at the top. The panel shows:

- the plugin's version, and a line with the last run (for example, "✓ Last sync 2 hours ago · already up to date"),
- buttons: **Sync from Discogs**, **Refresh prices**, **Rebuild dashboard**, **Export PDF**, and **Cancel** while something is running,
- while running, a step for each base and one for the dashboard, marked as active, done or failed, a progress bar and the current action,
- **Sync log**, which expands to show everything the last run did in this session.

The panel takes its colours from your Obsidian theme.

## 11. The Music Dashboard

`Music/Music Dashboard.md` is a live page. It reads your record notes every time you open it, so it is always up to date. It needs the Dataview and Charts plugins. (The PDF export in [section 12](#12-exporting-the-dashboard-as-a-pdf) doesn't.)

**Rebuild dashboard** writes the page from the template built into the plugin and fetches your collection's total value from Discogs. Every sync and price refresh also does this. Any edits you make to `Music Dashboard.md` are replaced at the next rebuild, so leave the page as it is. The template's source is `src/dashboard-template.md` in the repository.

### 11.1 Overview

A table with one row per base and a total, showing:

- **Records**
- **Tracks**, counted from the tracklists
- **Playing time**, added up from the track lengths
- **Lowest listings**: the cheapest copy on Discogs of each record, added up
- **Highest**: the Mint price suggestions added up; for the total, Discogs' own collection maximum when suggestions are missing (marked \*)
- **Ripped**: how many are ticked as ripped

### 11.2 Value spread

- **Whole collection**: Discogs' own low, medium and high value for your collection, and the sum of each record's G+, VG+ and NM price suggestions.
- **A typical record**: what the cheapest quarter of records are worth up to, the median record, where the top quarter starts, the most valuable record, and how much of the total value sits in your 20 most valuable records.
- **Records by value**: how many records fall in each price band, per base.
- **Where the value sits**: the total value in each price band.
- **Top 20 albums by value**: with the lowest listing, medium (VG+) and highest price for each. Click an album to open its note.

These use the VG+ price suggestion when available, and the cheapest listing otherwise.

### 11.3 What's in the collection

Pie charts of records per base and of the top ten genres, and a bar chart of the top 15 styles.

### 11.4 By decade

Records per decade of original release, per base.

### 11.5 Top artists

Your 15 most-collected artists. Compilations credited to "Various" are left out.

### 11.6 Buying

- **Records added per month**: the last 18 months, per base, using `purchased`, or the Discogs date added when `purchased` is empty.
- **Where you buy**: your top ten shops, from the `shop` property.
- **Latest additions, not listened to yet**: your 15 newest records you haven't marked as listened to. Tick the box to mark one as listened; its note gets `listened: true` and today's date in `listened_on`, and it leaves the list.

### 11.7 Colours

The dashboard uses your Obsidian theme's colours. Each base gets its own shade, and charts with many parts use shades that alternate from strong to faint so that neighbours stand apart. Change theme, or switch between light and dark, and the dashboard follows the next time it is drawn. With a single-colour theme, the labels and percentages identify each part.

## 12. Exporting the dashboard as a PDF

1. Press **Export PDF** on the sync panel, or run **Export dashboard as PDF…**.
2. Choose the **Paper size** and **Orientation**.
3. Press **Export PDF**.

The plugin builds the report itself, straight from your record notes: the same sections and figures as the Music Dashboard, with charts it draws on its own. It doesn't need Dataview or Charts, and the dashboard doesn't have to be open. Charts and tables are kept whole on a page, and every page has a footer with the date and page number. On landscape pages, charts sit two to a row; on portrait pages, one. The PDF is saved in `Music/Exports` as, for example, `Music Dashboard 2026-09-28 2105 A4 landscape.pdf`, and opened in your PDF viewer.

The PDF uses your theme's colours. With a dark theme, pages have a dark background.

## 13. Commands

Run these from the command palette (Ctrl/Cmd+P). You can give any of them a hotkey in **Settings → Hotkeys**.

| Command | Does |
|---|---|
| Open dashboard | Opens the Music Dashboard, creating it first if needed |
| Sync from Discogs | Adds new records to every base, then rebuilds the dashboard |
| Refresh prices | Updates price fields on every record, then rebuilds the dashboard |
| Rebuild dashboard | Rewrites the Music Dashboard and fetches your collection value |
| Cancel running sync | Stops after the current record |
| Export dashboard as PDF… | Opens the PDF export dialog |
| Add a base… | Opens the Add base dialog |

The ribbon's disc icon runs **Open dashboard**: it switches to the Music Dashboard if it's already open, and creates the dashboard note first if it doesn't exist yet.

## 14. Files and folders

| Path | Contents |
|---|---|
| `Music/<Base>/` | Record notes of one base |
| `Music/<Base>/covers/`, `Music/<Base>/images/` | Front covers and other photos |
| `Music/<Base>.base` | That base's Bases view |
| `Music/All Media.base` | Every base together |
| `Music/Music Dashboard.md` | The dashboard. It is rewritten on rebuild, so don't edit it. |
| `Music/Removed from collection/` | Notes of records you've removed from Discogs |
| `Music/Exports/` | PDF exports |
| `Music/.discogs-token`, `Music/.genius-token` | Your tokens |
| `Music/.vinyl-sync/collection-value.json` | Discogs' value for your collection, fetched at each rebuild |
| `Music/.vinyl-sync/last-export.html` | The page behind the last PDF export, kept for troubleshooting |
| `.obsidian/plugins/music-library-sync/` | The plugin: `main.js`, `manifest.json` and `styles.css` |
| `.obsidian/plugins/music-library-sync/data.json` | Your settings and bases, and the result of the last run |

Files and folders starting with a dot are hidden in Obsidian's file explorer.

## 15. Privacy and security

- The plugin connects only to `api.discogs.com` and `api.genius.com`, and only when you sync, refresh prices, rebuild the dashboard or test a token. There is no telemetry.
- Genius is sent only artist and track names.
- Tokens are kept in `Music/.discogs-token` and `Music/.genius-token`, never in `data.json`. The settings page never shows a saved token.
- **If your vault is in git, or synced somewhere shared, keep the token files out of it.** For git, add them to `.gitignore`:

  ```
  Music/.discogs-token
  Music/.genius-token
  ```

- If a token has ever been exposed, revoke it on Discogs or Genius, create a new one and paste it into settings.

## 16. Troubleshooting

**"Enter your Discogs username…", "Save your Discogs token…" or "Add a base… first"**
Setup isn't finished. Open **Settings → Discogs music sync and dashboard** and follow the **Getting started** list.

**"Couldn't read your Discogs collection"**
Shown by **Set up from Discogs**. Check your username and token with **Test**, then try again.

**"⚠ N records with the format … have no base"**
Those records aren't synced. Add a base for that format with **Set up from Discogs** or **Add base**, or add the format to an existing base.

**"⚠ <base>: no record in your collection has the format …"**
Nothing in your collection has that base's formats right now. Nothing is wrong if you haven't bought one yet; otherwise, edit the base and choose the right formats from the list.

**"Discogs didn't accept the token" or errors with 401**
The token is wrong or has been revoked. Generate a new one on Discogs and paste it in.

**Errors with 404 on every Discogs request**
The username is probably wrong. Check it, and press **Test** to see which account the token belongs to.

**"Discogs is busy (429) — waiting 15 s…"**
Normal on big syncs. The plugin waits and carries on by itself.

**"price suggestions need Discogs Seller Settings — skipping"**
See [section 9](#9-prices). Fill in your Discogs Seller Settings and run **Refresh prices**.

**Sync finished "with errors"**
Open **Sync log** on the panel. Each error names the base or step that failed. Other bases still sync.

**The dashboard shows code or "Enable the Charts plugin to see this chart."**
Install and enable Dataview (with **Enable JavaScript Queries** turned on in its settings) and Charts, then reopen the dashboard. The **Dashboard** section of the plugin's settings says which is missing.

**"No bases to show yet"**
Add a base (see [4.4](#44-set-up-your-bases)), then run **Sync from Discogs**.

**"PDF export isn't available in this version of Obsidian"**
PDF export relies on a part of Obsidian's desktop app that some versions don't provide. Please report it with **Report a bug**, including your Obsidian version.

**The dashboard is empty**
It waits up to 20 seconds for Dataview to index your notes after Obsidian starts. If it is still empty, check that your record notes have their base's tag, then reopen the dashboard.

**A new base doesn't appear on the dashboard**
Reopen the dashboard note. It reads the list of bases when it is drawn.

**"Add a base first — there's nothing to export yet"**
PDF export reports on your bases. Add one (see [4.4](#44-set-up-your-bases)) and run **Sync from Discogs**.

**Lyrics links are missing**
Check the Genius token with **Test**, and that **Add Genius lyrics links** is on. Some tracks just aren't on Genius. Links are only added to new records.

**"Music sync is already running"**
Only one sync, price refresh or rebuild runs at a time. Wait for it to finish, or cancel it.

**Changes to the plugin don't show**
Turn the plugin off and on in **Settings → Community plugins**, or restart Obsidian.

## 17. Frequently asked questions

**Will a sync overwrite what I've written in a note?**
No. Existing notes are never rewritten by a sync. **Refresh prices** changes only the price fields.

**Can I move or rename record notes?**
Yes, within their base's folder. The sync recognises notes by `discogs_instance`, not by file name. Keep each note in its base's folder and keep its tag, or it drops out of that base.

**Do I need to sort my records into folders on Discogs?**
No. Records are placed by format. Discogs folders are ignored.

**Can one base take several formats?**
Yes, for example `CD`, `CDr` and `SACD` in one CDs base. Each format can belong to only one base.

**Why is a price field empty?**
Either Discogs has no data for that release, nobody is selling it, or your Seller Settings aren't filled in (for the suggestion fields).

**Can I change the currency?**
Not yet. Prices are in Swedish kronor.

**Does it work on mobile?**
No. The plugin is desktop only.

## 18. Getting help

At the bottom of **Settings → Discogs music sync and dashboard**:

- **Report a bug** opens a bug report on GitHub, labelled `bug`. Include the plugin version (shown at the bottom of the settings page), what you did, what happened, and the relevant lines from the **Sync log**. Remove any tokens first.
- **Request a feature** opens a feature request, labelled `enhancement`.

Discogs music sync and dashboard is created by Anthony Fitzpatrick, Wolf 359 Press AB.
