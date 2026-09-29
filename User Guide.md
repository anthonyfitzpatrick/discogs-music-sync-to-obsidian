# Discogs music sync and dashboard User Guide

Discogs music sync and dashboard (repository: *Discogs Music Sync to Obsidian*, plugin ID `music-library-sync`) turns your Discogs collection into a music library inside your Obsidian vault. This guide explains how to set it up and how to use each part of it.

## Contents

1. [About the plugin](#1-about-the-plugin)
2. [Requirements](#2-requirements)
3. [Installation](#3-installation)
4. [First-time setup](#4-first-time-setup)
5. [The settings page](#5-the-settings-page)
6. [Bases](#6-bases)
7. [Syncing from Discogs](#7-syncing-from-discogs)
8. [Record notes](#8-record-notes)
9. [Prices](#9-prices)
10. [The Music Dashboard](#10-the-music-dashboard)
11. [The Music Library](#11-the-music-library)
12. [Exporting the dashboard as a PDF](#12-exporting-the-dashboard-as-a-pdf)
13. [Commands and ribbon icons](#13-commands-and-ribbon-icons)
14. [What the plugin keeps where](#14-what-the-plugin-keeps-where)
15. [Upgrading from an earlier version](#15-upgrading-from-an-earlier-version)
16. [Privacy and security](#16-privacy-and-security)
17. [Troubleshooting](#17-troubleshooting)
18. [Frequently asked questions](#18-frequently-asked-questions)
19. [Getting help](#19-getting-help)

## 1. About the plugin

Discogs is where you catalogue the records you own. This plugin brings that catalogue into Obsidian, where you can annotate it, link it and see it at a glance.

For every record in your Discogs collection, the plugin creates a note with:

- the front cover, plus every other photo Discogs has (back cover, labels, inserts),
- the full tracklist, with track lengths and links to lyrics on Genius,
- label, catalogue number, country, format, release year and original release year,
- genres and styles,
- your media and sleeve condition, and your notes, from Discogs,
- current Discogs prices in Swedish kronor.

Records are grouped into **bases** by their format — by default **Vinyl**, **CDs** and **Tapes** — automatically, wherever they are in your Discogs collection.

Everything else is inside the plugin:

- the **Music Dashboard**, with your collection's figures and charts,
- the **Music Library**, to browse your records as a gallery or tables,
- **PDF export** of the dashboard,
- your **settings and tokens**.

It needs no other plugin, and it puts nothing in your vault except your record notes and their images.

The plugin is careful with your notes:

- A sync only **adds** records. It never overwrites a note that already exists, so anything you write in a record note is safe.
- **Refresh prices** changes only the price fields.
- When you remove a record from Discogs, its note is **moved** to *Removed from collection* in your library folder, never deleted.

## 2. Requirements

| Requirement | Why |
|---|---|
| Obsidian 1.13 or later, on desktop (macOS, Windows or Linux) | The plugin and its PDF export run on desktop only. |
| A Discogs account with your records in your collection | This is where the records come from. |
| A Discogs personal access token | Lets the plugin read your collection and prices. |
| A Genius API access token (optional) | Adds lyrics links to tracklists. |

No other plugin is needed.

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

1. Sign in at [discogs.com](https://www.discogs.com) and open [discogs.com/settings/developers](https://www.discogs.com/settings/developers) (Settings → Developers).
2. Press **Generate new token** and copy it.

The plugin's settings link to the same page, under the token field, with these steps under **How to get a token**. Until you are set up, **Getting started** at the top of the settings lists each step (username, Discogs token, Genius token, first sync) and crosses it out as you do it.

The token gives read access to your account. Treat it like a password.

### 4.2 Get a Genius token (optional)

1. Sign in at [genius.com](https://genius.com) and open [genius.com/api-clients](https://genius.com/api-clients).
2. Press **New API Client**. Any app name and website address will do, such as "Obsidian" and `https://obsidian.md`. Save it.
3. Press **Generate Access Token** under the new client and copy the token.

The plugin's settings link to the same page, under the Genius token field, with these steps.

### 4.3 Enter them in Obsidian

1. Open **Settings → Discogs music sync and dashboard**. Until setup is done, the top of the page shows a **Getting started** list, and ticks off each step as you finish it.
2. Under **Discogs**, type your Discogs **Username**.
3. Paste your Discogs token into **Personal access token** and press Enter or click elsewhere. The description changes to "A token is saved on this device."
4. Press **Test**. You should see "Connected as *your name*".
5. Under **Lyrics**, paste your Genius token into **Genius access token** and press **Test**.

Tokens are kept by the plugin on this device, not in a file (see [section 16](#16-privacy-and-security)). If you use the vault on another computer, enter them there too.

### 4.4 Set up your bases

Every record on Discogs has a format, such as Vinyl, CD or Cassette. The plugin puts each record in the base for its format, automatically: you don't have to sort your collection into folders on Discogs.

**You don't need to do anything here.** The first sync reads the formats in your collection and creates a base for each one, then fills them in the same run. A box set goes by the media inside it, so a box set of LPs goes to Vinyl. Later syncs do the same for any format new to your collection. Turn this off with **Create bases automatically** (see [5.3](#53-bases)).

To choose the bases yourself before the first sync:

1. Under **Bases**, press **Set up from Discogs**. The button works once your username and token are saved.
2. The dialog reads your collection and lists every format in it, with how many records have each. All are ticked; untick any you don't want.
3. Press **Add bases**.

Each format becomes a base with the format's name, for example `Vinyl` becomes the folder `Music/Vinyl/` (in your library folder, see [5.1](#51-library-folder-and-discogs)) and the tag `#vinyl-library`, with an icon to match. You can rename bases afterwards (see [6.3](#63-editing-and-renaming-a-base)), or add more with **Add base** (see [6.2](#62-adding-a-base)).

### 4.5 Run the first sync

Press the disc icon in the ribbon to open **Music**, then press **Sync from Discogs** at the top. You can also run **Discogs music sync and dashboard: Sync from Discogs** from the command palette.

The first sync can take a while. Discogs allows about one request a second, and each record needs several requests: the release, its master, prices, cover and photos. Expect roughly 5 to 15 seconds per record, plus time for Genius lookups. A collection of 150 records takes about half an hour. Later syncs only fetch new records, so they are quick.

You can keep working in Obsidian while it runs; the panel at the top of the dashboard shows the progress.

## 5. The settings page

Open **Settings → Discogs music sync and dashboard**. Changes are saved as you make them and apply from the next sync. Every setting also turns up in Obsidian's settings search, so typing "token" or "paper size" in the search box at the top of Settings finds it.

### 5.1 Library folder and Discogs

- **Library folder**: the folder new bases get their folders in, and where removed records and PDF exports go. It is `Music` unless you change it, and can be anywhere in your vault, such as `Collections/Records`. Bases you already have keep their folders. A name Obsidian can't use (one starting with a dot, or containing `\ : * ? " < > | # ^ [ ]`) is shown in red under the field and isn't saved.
- **Username**: the Discogs account whose collection is synced.
- **Personal access token**: paste your token into the field. It is saved on this device at once and the field empties; "Saved on this device. Press Test to check it." appears under it. (A typed token is saved when you press Enter or leave the field.) The field is masked. Paste a new token at any time to replace it.
- **Test**: checks the saved token with Discogs, and the answer appears under the field. If there is still a token in the field, Test saves it first, so one press is enough.
  - "✓ Connected to Discogs as *name*" means everything is fine.
  - "✗ The token belongs to *X*, but the username above is *Y*" means the token and username don't match. Syncing uses the username, so fix whichever is wrong.
  - "✗ Discogs didn't accept the token" means the token is wrong or has been revoked. Generate a new one and paste it.
  - If the username is empty when the token is checked, it is filled in from the token.

### 5.2 Lyrics

- **Add Genius lyrics links**: when on, each track of a newly added record is looked up on Genius. Turn it off to make syncing faster.
- **Genius access token** and **Test**: work the same way as the Discogs token: paste it, then press Test for Genius's answer.

### 5.3 Bases

- **Create bases automatically** (on unless you turn it off): each sync creates a base, named after the format, for every format in your collection that has none.
- **Formats left out**: shown when you have stopped syncing a base. Its formats are listed here and no base is created for them automatically. **Create them again** lets the next sync recreate them.
- **Set up from Discogs** adds bases for formats in your collection that don't have one yet, choosing them yourself instead of waiting for a sync. It is greyed out until a username and token are saved.

Below it, the list shows every base with its icon, name, formats, folder and tag.

- The **+** button at the top of the list creates a base by hand.
- The **pencil** button edits or renames a base.
- The **delete** button stops syncing it, after asking. You can also select a base and press Delete.

See [section 6](#6-bases).

### 5.4 Files from earlier versions

Shown only if your vault still has files that earlier versions of the plugin made and this version no longer uses (see [section 15](#15-upgrading-from-an-earlier-version)). It lists them, and **Move to trash** moves them to the trash after asking (the system trash or the vault's `.trash` folder, as chosen under Settings → Files and links), so you can get them back.

### 5.5 Dashboard

A switch for each of the dashboard's thirteen sections (see [section 10](#10-the-music-dashboard)). Turn off the ones you don't want; they are left out of the dashboard and its PDF.

### 5.6 Colours

- **Chart colours**: **Theme** (shades of your theme's colours, the default), **Full colour** (the plugin's original purple, pink and orange) or **Custom**.
- With **Custom**: a colour picker for each base, and an **Accent** colour for charts with many parts and for value scales.

Text, lines and backgrounds always follow your theme.

### 5.7 Sync

- **Download all images**: when on, every Discogs photo of a new record (back cover, labels, inserts) is saved and shown under **Images** in its note. When off, only the single front cover is downloaded, which makes syncing faster and uses less space.

### 5.8 PDF export

- **Paper size**: A5, A4, A3, Letter, Legal or Tabloid.
- **Orientation**: Portrait or Landscape.

These are the defaults for the export dialog. Whatever you pick in the dialog is also remembered here.

### 5.9 About

The bottom of the page shows the plugin's version, and buttons to report a bug, request a feature, and visit the author's and Wolf 359 Press's websites. See [section 19](#19-getting-help).

## 6. Bases

### 6.1 What a base is

A base takes every record of the formats you choose, from anywhere in your Discogs collection, into:

- its own **folder** inside your library folder, which holds its record notes, a `covers/` folder and an `images/` folder,
- its own **tag**, such as `#vinyl-library`, which every record note in it carries,
- its own place in the **Music Library** and on the **Music Dashboard**.

### How records find their base

- Each base takes one or more **formats**, as Discogs names them: for example Vinyl takes `Vinyl`, and CDs might take `CD` and `CDr`.
- Formats are **chosen from the formats in your collection, never typed**, so a misspelling can't send records nowhere.
- Each format belongs to **one base only**.
- A record with several formats goes to the base of the **first** of them that has one, in the order Discogs lists them. A box set listed as *Box Set, Vinyl* goes to your Vinyl base, unless you have a base for Box Set.
- A format with no base gets one at the next sync, named after it (see [4.4](#44-set-up-your-bases)). A record is left unsynced only when you have stopped syncing its format or turned automatic bases off, and every sync says so in the log and the summary, so nothing is left out without you knowing.

### 6.2 Adding a base

Say you've started collecting MiniDiscs and added some to your Discogs collection.

1. Open **Settings → Discogs music sync and dashboard** and press **Add base**, or run **Discogs music sync and dashboard: Add a base…**.
2. Enter a **Name**, for example `MiniDiscs`. This becomes the folder name and the name in the Library and on the Dashboard.
3. Under **Formats**, turn on the formats the base takes, for example `Minidisc`. The dialog lists every format in your collection with its record count; formats another base already takes are shown as taken and can't be turned on. If your collection can't be read, formats can't be chosen: check your username and token with **Test**.
4. Choose an **Icon**. It is shown in the settings list and in the sync progress.
5. The dialog shows what it will create, for example: *Creates Music/MiniDiscs/ and the tag #minidiscs-library.* (`Music` is your library folder.)
6. Press **Add base**.

The folder is created straight away. The next sync fills the base with records. If a base's folder goes missing later, the next sync creates it again.

### 6.3 Editing and renaming a base

Press the pencil next to a base. You can change:

- **Name**: renames the base in the Library and on the Dashboard. The notes stay where they are, and the tag doesn't change.
- **Formats**: which formats the base takes. When you change them, the next sync moves any record whose format now belongs to a different base.
- **Icon**.

### 6.4 Name rules

Each base must have its own name. The **Add base** and **Save** buttons stay disabled, and the dialog explains why, when:

- **another base already has that name.** Capitals and extra spaces don't count, so `vinyl`, `VINYL` and `  Vinyl ` are all the same as `Vinyl`.
- **the name is too close to another base's.** Names that differ only in punctuation or spacing, such as `Mini Disc` and `Mini-Disc`, would produce the same tag.
- **no format is chosen**, or **a chosen format already belongs to another base**. Each format can belong to only one base.
- **your library folder already has a folder with that name**, such as `Exports` or `Removed from collection`.
- **the name contains a character that isn't allowed in file names** (`\ / : * ? " < > | # ^ [ ]`), or starts with a dot.
- the name is empty, has no letters or numbers, or is longer than 60 characters.

### 6.5 Removing a base

Press the delete button next to a base and confirm. The base stops syncing and disappears from the Library and the Dashboard. Its formats are listed under **Formats left out**, so a sync doesn't create the base again.

Its folder and notes stay in your vault. Delete them yourself if you no longer want them. Because the folder still exists, you can't add a new base with the same name until you rename or delete it.

You can remove every base. The Library and Dashboard then say there are no records to show. With **Create bases automatically** off, a sync then asks you to add one.

## 7. Syncing from Discogs

Start a sync with the **Sync from Discogs** command, or the **Sync from Discogs** button on the sync panel (at the top of the Music Dashboard).

A sync:

1. reads your whole Discogs collection, every folder and every page,
2. creates a base for each format that has none (see [4.4](#44-set-up-your-bases)), puts each record in the base for its format (see [6.1](#61-what-a-base-is)), and reports records left without a base, and bases whose formats no record has,
3. finds every existing record note, in every base, matching on each note's `discogs_instance`,
4. moves notes of records that have left your collection (see [7.2](#72-records-you-remove-from-discogs)),
5. moves notes that are in the wrong base, for example after you change a base's formats (see [7.3](#73-records-in-the-wrong-base)),
6. creates a note for each new record, base by base (see [section 8](#8-record-notes)),
7. fetches Discogs' own value of your collection, for the dashboard.

The summary at the end says how many records were added, moved and removed, and how many have no base.

### 7.1 Records you add

Each new record gets a note named `Artist - Title.md` in its base's folder. Characters that aren't allowed in file names are removed, and names are cut at 150 characters. If a note with that name already exists (for example, two pressings of the same album), the new one is called `Artist - Title (2).md`.

The same album can be in your collection more than once; each copy gets its own note.

### 7.2 Records you remove from Discogs

If a record is no longer anywhere in your Discogs collection, its note is moved to *Removed from collection* in your library folder. Its tag is changed to `#removed-from-collection` and a `removed_from_collection` date is added, so it drops out of the bases and the dashboard but keeps everything you wrote in it.

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
| `shop` | Where you bought it. Shown in the Library's Catalogue view, and searchable. |
| `price_paid_sek` | What you paid, for your own records. Left empty for you to fill in; the dashboard doesn't use it. |
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

**Refresh prices** (button or command) fetches new prices for every record in every base and rewrites only the price fields. It takes about two seconds per record. Records without a `discogs_id` are skipped. When it finishes, it refreshes Discogs' value of your collection.

## 10. The Music Dashboard

Press the **disc icon** in the ribbon to open **Music**, the plugin's own view. It opens as a tab, and pressing the icon again brings it back rather than opening another.

**Music** has the sync panel at the top, and two tabs below it:

- **Dashboard**: your collection's figures and charts (this section),
- **Library**: your records, as a gallery or tables ([section 11](#11-the-music-library)).

It opens on the tab you used last. **Open dashboard** and **Open library** in the command palette open it on that tab.

The **sync panel** has:

- the plugin's version, and a line with the last run (for example, "✓ Last sync 2 hours ago · already up to date"),
- buttons: **Sync from Discogs**, **Refresh prices**, **Library** (switches to the Library tab), **Export PDF**, and **Cancel** while something is running,
- while running, a step for each base and one for the collection value, marked as active, done or failed, a progress bar and the current action,
- **Sync log**, which expands to show everything the last run did in this session.

The same panel can be added to any note with a code block:

````
```music-sync
```
````

Below the panel are your collection's figures, read from your record notes. The dashboard redraws by itself shortly after a record note changes, is added, moved or removed, and when you change theme.

The dashboard has thirteen sections, in this order. Turn any of them off in **Settings → Dashboard** (see [10.14](#1014-choosing-sections-and-colours)).

### 10.1 Overview

A table with one row per base and a total, showing:

- **Records**
- **Tracks**, counted from the tracklists
- **Playing time**, added up from the track lengths
- **Lowest listings**: the cheapest copy on Discogs of each record, added up
- **Highest**: the Mint price suggestions added up; for the total, Discogs' own collection maximum when suggestions are missing (marked \*)

### 10.2 Growth over time

- **Records owned**: how many records you owned at the end of each month, per base and in all, from each record's purchase date (or the date it was added to Discogs).
- **Collection value (Discogs)**: Discogs' low, median and high value of your collection at each sync, one point per day. It starts with the first sync after you install version 0.12, and the chart appears once there are two syncs on different days.

### 10.3 Value spread

- **Whole collection**: Discogs' own low, medium and high value for your collection (fetched with each sync), and the sum of each record's G+, VG+ and NM price suggestions.
- **A typical album, by format**: for each Discogs format in your collection (Vinyl, CD, Cassette…) and for all of them together: how many records, what the cheapest quarter are worth up to, the median record, where the top quarter starts, the most valuable record, and how much of the value sits in the 20 most valuable. A record's format is the first Discogs lists for it, skipping *Box Set* and *All Media*, which only wrap the discs inside: a box set of LPs counts as Vinyl.
- **Records by value**: how many records fall in each price band, per base.
- **Where the value sits**: the total value in each price band.
- **Top 20 albums by value**: with the lowest listing, medium (VG+) and highest price for each. Click an album to open its note in reading view (Ctrl/Cmd-click for a new tab).

These use the VG+ price suggestion when available, and the cheapest listing otherwise.

### 10.4 Market

- **Rarest**: your records with the fewest copies for sale on Discogs, the most valuable first where counts tie.
- **In demand**: records whose cheapest copy on Discogs costs more than Discogs' VG+ price estimate, with how far above it is.
- **Easiest to replace**: records with the most copies for sale.

### 10.5 What's in the collection

Doughnut charts of records per base and of the top ten genres, and a bar chart of the top 15 styles.

### 10.6 Pressings

- **Country of release** and **Top labels**: your ten most common of each.
- **Original releases and reissues**: a reissue is a copy Discogs describes as a reissue, repress or remaster. A release year later than the original doesn't count on its own, since a record often came out a year later in another country as a first pressing.
- **Albums and compilations**: from Discogs' description of each release.

### 10.7 By decade

Records per decade of original release, per base.

### 10.8 Top artists

Your 15 most-collected artists. Compilations credited to "Various" are left out.

### 10.9 Playing time

- **Longest albums**: your ten longest, with track counts, from the tracklists.
- **Hours of music by decade**: per base.

### 10.10 Buying

- **Records added per month**: the last 18 months, per base, using `purchased`, or the Discogs date added when `purchased` is empty.
- **Latest additions, not listened to yet**: your 15 newest records you haven't marked as listened to. Tick **Listened** to mark one; its note gets `listened: true` and today's date in `listened_on`, and it leaves the list.

### 10.11 Listening

**Waiting longest**: the ten records you've owned longest without listening to them, with a Listened box to tick them off.

### 10.12 Condition

Media and sleeve conditions, best grade first. Conditions are copied from your Discogs collection when a record is first synced, so grade copies on Discogs before syncing them, or fill in `media_condition` and `sleeve_condition` in the note. Until any record is graded, the section says so.

### 10.13 Needs attention

What's missing from your record notes: purchase dates, shops, original years, prices, covers and genres, with how many records lack each and the first few of them (click one to open its note).

### 10.14 Choosing sections and colours

- **Sections**: **Settings → Dashboard** has a switch for each section. Sections that are off are left out of the dashboard and its PDF.
- **Colours**: **Settings → Colours → Chart colours**:
  - **Theme** (the default): shades of your theme's own colours.
  - **Full colour**: the plugin's original purple, pink and orange.
  - **Custom**: a colour picker for each base, and an **Accent** colour that the charts with many parts (genres, styles, artists, labels, countries) and the value scales start from.

  In every mode, text, lines and backgrounds follow your theme, so everything stays readable. With a single-colour theme and **Theme** colours, the labels and percentages identify each part.

## 11. The Music Library

Open **Music** with the disc icon and choose the **Library** tab, or run **Open library**, or press **Library** on the sync panel.

Along the top:

- **Base**: all bases, or one.
- **View**:

  | View | Shows |
  |---|---|
  | Gallery | Cover cards |
  | By genre | Cover cards, grouped by genre (a record with several genres appears in each) |
  | Catalogue | A table: artist, album, year, label, catalogue number, country, genres, purchase date, shop, conditions, lowest listing |
  | Value | A table of every price field, most valuable first |

- **Size** (for Gallery and By genre): **Artwork only** (covers alone, packed closer; hover over a cover for the album and artist), **Small** (cover, album, artist and year; the default) or **Large** (bigger covers and text).
- **Sort**: the view's own order, or artist, album, year, newest first or most valuable.
- **Search**: artist, album, label, catalogue number, country, shop, base, genre or style. Every word must match.

The count on the right says how many records are shown. Click a record to open its note in reading view (Ctrl/Cmd-click for a new tab). The Library remembers your choices, and redraws by itself when record notes change, keeping your place in the list. After opening a record, **Back** returns you to the same place.

## 12. Exporting the dashboard as a PDF

1. Press **Export PDF** on the sync panel, or run **Export dashboard as PDF…**.
2. Choose the **Paper size** and **Orientation**.
3. Press **Export PDF**.

The PDF has the same sections, figures and charts as the dashboard, drawn by the plugin itself. Charts and tables are kept whole on a page, and every page has a footer with the date and page number. On landscape pages, charts sit two to a row; on portrait pages, one. The PDF is saved in `Exports` in your library folder as, for example, `Music Dashboard 2026-09-28 2105 A4 landscape.pdf`, and opened in your PDF viewer.

The PDF uses your theme's colours. With a dark theme, pages have a dark background.

## 13. Commands and ribbon icons

Run these from the command palette (Ctrl/Cmd+P). You can give any of them a hotkey in **Settings → Hotkeys**.

| Command | Does |
|---|---|
| Open dashboard | Opens Music on the Dashboard tab |
| Open library | Opens Music on the Library tab |
| Sync from Discogs | Adds new records, places every record in its base, then refreshes the collection value |
| Refresh prices | Updates price fields on every record, then refreshes the collection value |
| Refresh collection value | Fetches Discogs' own value of your collection for the dashboard |
| Cancel running sync | Stops after the current record |
| Export dashboard as PDF… | Opens the PDF export dialog |
| Add a base… | Opens the Add base dialog |

The ribbon's **disc** icon opens **Music**, on the tab you used last.

## 14. What the plugin keeps where

**In your vault** — only your library:

| Path | Contents |
|---|---|
| `<library folder>/<Base>/` | Record notes of one base |
| `<library folder>/<Base>/covers/`, `…/images/` | Front covers and other photos |
| `<library folder>/Removed from collection/` | Notes of records you've removed from Discogs |
| `<library folder>/Exports/` | PDFs you export |

The library folder is `Music` unless you change it in settings.

**In the plugin** — everything else:

| What | Where |
|---|---|
| The Music view, its Dashboard and Library tabs, charts and layout | The plugin's code |
| Settings (including the library folder, dashboard sections and colours), bases, the last run, the collection value and its history, the last tab and the Library's last choices | `.obsidian/plugins/music-library-sync/data.json` |
| Discogs and Genius tokens | Obsidian's secret storage on this device, encrypted by the operating system |

## 15. Upgrading from an earlier version

Earlier versions kept some things in your vault, always in `Music/`. From 0.11 the plugin does it all itself:

| Earlier | Now |
|---|---|
| `Music/Music Dashboard.md`, which needed Dataview and Charts | The Music Dashboard view |
| `Music/Vinyl.base`, `CDs.base`, `Tapes.base` and `All Media.base`, which needed Bases | The Music Library view |
| `Music/.discogs-token`, `Music/.genius-token` | Tokens kept on this device, read in from the old files automatically |
| `Music/.vinyl-sync/collection-value.json`, `last-export.html` | The plugin's settings, or no longer needed |

Your bases and settings carry over. The old files are left alone until you choose to remove them: **Settings → Files from earlier versions → Move to trash** (see [5.4](#54-files-from-earlier-versions)). If you had edited a `.base` file and want to keep it, leave it; Obsidian's Bases still opens it.

## 16. Privacy and security

- The plugin connects only to `api.discogs.com` and `api.genius.com`, and only when you sync, refresh prices or the collection value, set up or edit bases, or test a token. There is no telemetry.
- Genius is sent only artist and track names.
- Tokens are kept in Obsidian's secret storage on this device, which the operating system encrypts; they appear under Settings → Keychain. Tokens saved by versions 0.11 and 0.12 move there on their own the first time 0.13 loads. They are never written to a file, the vault or the plugin's `data.json`, so they can't end up in git or a shared sync. The settings page never shows a saved token.
- If a token has ever been exposed, revoke it on Discogs or Genius, create a new one and paste it into settings.

## 17. Troubleshooting

**"Enter your Discogs username…", "Save your Discogs token…" or "Add a base… first"**
Setup isn't finished. Open **Settings → Discogs music sync and dashboard** and follow the **Getting started** list.

**"Couldn't read your Discogs collection"**
Shown by **Set up from Discogs** and the base dialog. Check your username and token with **Test**, then try again.

**"⚠ N records with the format … have no base"**
Those records aren't synced, because you stopped syncing their format or turned **Create bases automatically** off. Press **Create them again** under **Formats left out**, add a base with **Set up from Discogs** or **Add base**, or add the format to an existing base.

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
Open **Sync log** on the panel. Each error names the step that failed.

**The token is saved on one computer but not another**
Tokens are kept per device. Paste them into settings on each computer you use.

**"No bases to show yet" or "No records match"**
Add a base (see [4.4](#44-set-up-your-bases)) and run **Sync from Discogs**, or clear the Library's search.

**"PDF export isn't available in this version of Obsidian"**
PDF export relies on a part of Obsidian's desktop app that some versions don't provide. Please report it with **Report a bug**, including your Obsidian version.

**"Music sync is already running"**
Only one sync, price refresh or value refresh runs at a time. Wait for it to finish, or cancel it.

**Changes to the plugin don't show**
Turn the plugin off and on in **Settings → Community plugins**, or restart Obsidian.

## 18. Frequently asked questions

**Will a sync overwrite what I've written in a note?**
No. Existing notes are never rewritten by a sync. **Refresh prices** changes only the price fields. A note moved to the right base keeps everything you wrote.

**Can I move or rename record notes?**
Yes, within their base's folder. The sync recognises notes by `discogs_instance`, not by file name. Keep each note in its base's folder and keep its tag, or it drops out of that base.

**Do I need other plugins, such as Dataview, Charts or Bases?**
No. The dashboard, library and PDF export are all built into the plugin.

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

## 19. Getting help

At the bottom of **Settings → Discogs music sync and dashboard**:

- **Report a bug** opens a bug report on GitHub, labelled `bug`. Include the plugin version (shown at the bottom of the settings page), what you did, what happened, and the relevant lines from the **Sync log**. Remove any tokens first.
- **Request a feature** opens a feature request, labelled `enhancement`.

Discogs music sync and dashboard is created by Anthony Fitzpatrick, Wolf 359 Press AB.
