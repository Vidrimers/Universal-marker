# 💀 Universal Marker

[English](README.md) | [Русский](README.ru.md)

Tampermonkey userscript — highlights nicknames and shows messages on profiles on any site. Essential for forums, marketplaces and any community where you need to remember who is who.

> Version: 6.7.3 | Works on any site (`*://*/*`)

---

## 📋 Contents

- [Installation](#installation)
- [Features](#features)
  - [Nickname highlighting](#nickname-highlighting)
  - [Profile messages](#profile-messages)
  - [Steam](#steam)
  - [Quick labels](#quick-labels)
  - [Bulk add](#bulk-add)
  - [Search](#search)
  - [Notes](#notes)
  - [Settings](#settings)
  - [Export and import](#export-and-import)
  - [Updates](#updates)
- [Data storage](#data-storage)
- [License](#license)

---

## Installation

**Step 1.** Install the Tampermonkey extension for your browser:

- [Chrome / Edge / Opera](https://www.tampermonkey.net/)
- [Firefox](https://www.tampermonkey.net/?browser=firefox)

**Step 2.** Click the button below to install the script:

[![Install script](https://img.shields.io/badge/Install-Tampermonkey-green?style=for-the-badge&logo=tampermonkey)](https://raw.githubusercontent.com/Vidrimers/Universal-marker/refs/heads/master/universal.user.js)

> When you open the link, Tampermonkey recognizes the script and opens the install dialog. Click **"Install"**.

---

## Features

After installation a small 💀 button appears in the bottom left corner of any page. Click it to open the control panel. If Duo Helper is also on the page, the FABs magnetically snap to each other (horizontally or vertically); to undock — just drag it away while dragging.

![alt](img/fab.png)

<!-- ![alt](img/modal_overview.png) -->

---

### Nickname highlighting

The **👤 Nicks** tab — add a user's nickname and a label. The script finds every mention of that nickname on the page and appends your label next to it in color.

**Example:**

```
beex → scammer
```

Result on the page: `beex` **(scammer)**

Each nickname can have an **individual label color** — e.g. red for toxic users, green for verified people. The default color comes from settings.

![alt](img/modal_overview.png)

![alt](img/nick_highlight.png)

---

### Profile messages

The **💀 Profiles** tab — when you open a specific user's profile page, a big message appears in the center of the screen.

You need to specify the **user ID** (numeric) and the message text. The script automatically detects the ID from the URL using the configured patterns.

**Example:** opening `/seller/beex/1179730` shows the message **SCAMMER**.

![alt](img/center_message.png)

---

### Steam

On Steam pages (`steamcommunity.com`) the script detects the SteamID64 of the open profile on its own — a quick-add block appears in the panel: a label for the profile and a label for the nickname in one click.

**Renames** — if a marked person changes their Steam nickname, the label automatically moves to the new one (color, text and note are kept), otherwise highlighting would "lose" them.

How it works: once a day the script sends only the list of SteamIDs of your marked nicks to the author's server and gets their current names. Labels, notes and settings are not sent — they stay in Tampermonkey locally.

---

### Quick labels

The **▾ Quick labels** button under the add row — shows a list of all unique labels you have already used. Click a label to instantly fill the field along with the color — no need to type the same thing over and over.

![alt](img/presets.png)

---

### Bulk add

The **▼ Bulk add** button — lets you add up to 100 nicknames at once. Paste a list of nicknames one per line, set a shared label and color.

![alt](img/bulk_add.png)
![alt](img/bulk_add2.png)

---

### Search

Each tab has a search bar — it filters the list instantly as you type. Search works across nickname, label and note text at once. Shows a counter of found entries.

![alt](img/search.png)

---

### Notes

Every nickname has a note button:

- **+** (semi-transparent) — no note yet, click to add
- **✎** (blue) — a note exists, click to view or edit

The note expands right under the nickname row — it takes no extra space when not needed.

![alt](img/note_open.png)

---

### Settings

The **⚙️ Settings** tab:

| Parameter | Description |
| --------------------- | ------------------------------------------- |
| Language | Interface language (English / Русский), applies to all sites |
| Nick label color | Default color for new nicknames |
| Message color (center) | Text color of the big profile message |
| Border color | Border color of the big message |
| Font size (center) | Message text size, e.g. `42px` |
| Show always | The profile message never fades on its own |
| URL patterns for ID | Regex to extract the user ID from the URL |

**URL patterns** — if a site uses a non-standard profile link format, add your own pattern. By default these formats are supported: `/profile/123`, `/member/123`, `?u=123`.

Example for plati.market: `/seller/[^/]+/(\d+)`

![alt](img/settings.png)

---

### Export and import

Export is **one file for all sites at once** (there is no separate per-site export). Each site's data in the file sits under its own `vm_<domain>` key. Buttons are in the **⚙️ Settings** tab:

| Button | Action |
| ---------------------- | -------------------------------------------- |
| 📥 Export | Download data for all sites as one JSON file |
| 📤 Import | Load data for all sites from a JSON file |
| 🔍 Check for updates | Check GitHub for a new script version |

The header buttons: 🔄 reloads the page (apply changes), 🐛 opens the bug report form. In the footer: **"Support the project"** and **"License"**.

---

### Updates

When the panel opens, the script quietly checks GitHub for a new version (at most once a day). If an update is available — a green banner appears:

```
🆕 Update available: v6.6 → v6.7   [⬆️ Install]
```

Click **"Install"** — Tampermonkey opens the update dialog.

---

## Data storage

Data is saved to Tampermonkey storage (`GM_storage`) — it **survives** cookie and browser cache clears. Each site keeps its data separately.

JSON structure on export (all sites in one file):

```json
{
  "vm_example.com": {
    "nicknames": {
      "username": {
        "label": "toxic",
        "color": "#ff4444",
        "note": "rude in every thread"
      }
    },
    "profileMessages": {
      "123456": "SCAMMER"
    },
    "settings": { ... }
  }
}
```

---

## License

**CC BY-NC-ND 4.0** — [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/)

| | |
|---|---|
| ✅ Use for free | ✅ |
| ✅ Share with attribution | ✅ |
| ❌ Commercial use | ❌ |
| ❌ Modifications and derivatives | ❌ |

**For commercial use** — contact the author to obtain a license.
