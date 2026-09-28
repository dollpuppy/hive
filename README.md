# Hive

**Co-streaming made easy!** Share sources OBS-style between streamers, set up with a single shared link.

> ### 📦 [Download the Pre-release here](https://github.com/dollpuppy/hive/releases/tag/Pre-Release)

Built with Claude Code (agentic engineering, not vibe coding!) and lots of caffeine by a real, human developer :3

---

## Requirements

- Windows 10 or 11 (64-bit)
- [OBS Studio](https://obsproject.com/)
- *Optional:* [obs-spout2-plugin](https://github.com/Off-World-Live/obs-spout2-plugin), if you want to share or receive sources over Spout2

## Installation

1. Download **`Hive Setup 0.1.0.exe`** from the [Pre-release page](https://github.com/dollpuppy/hive/releases/tag/Pre-Release).
2. Run it. The installer is one-click: no options, and no admin rights needed. Hive installs for your user only and opens when it's done.

### What to expect from Windows and your antivirus

Hive is a pre-release and **isn't code-signed yet**. Signing certificates are pricey! Because of that, Windows and some antivirus tools will be cautious the first time. This is expected:

| You see | Why | What to do |
| --- | --- | --- |
| Your browser says the file *"isn't commonly downloaded"* or *"could harm your device"* | New, unsigned `.exe` files that few people have downloaded get flagged automatically | Choose **Keep** (in Edge: **⋯ → Keep → Keep anyway**) |
| **"Windows protected your PC"** (blue SmartScreen box) | Same reason: Windows doesn't recognise the publisher yet | Click **More info → Run anyway** |
| **Windows Defender Firewall** asks about network access for Hive | Hive runs a small local server and connects to your co-streamer | Click **Allow**. Private networks are enough. |
| Antivirus flags **`cloudflared.exe`** | Hive bundles Cloudflare's official tunnel tool to create invite links. Some antivirus tools flag tunnel tools as "potentially unwanted" on principle. | Allow or restore it. It's only used while you have **Start Server** running. |

If your antivirus quarantines something else, or blocks the install outright, please open an issue and include the antivirus name and the exact message.

### Where it goes

- App: `%LOCALAPPDATA%\Programs\Hive`
- Settings: `%APPDATA%\Hive`

### Uninstalling

Go to **Settings → Apps → Installed apps → Hive → Uninstall**. Your settings are kept in case you reinstall. Delete `%APPDATA%\Hive` to remove them too.

## Quick start

1. **Host:** click **Start Server**, then **Copy invite link** and send it to your co-streamer.
2. **Guest:** paste the link into Hive's **Join** box and click **Join**. If you open the link in a browser instead, it'll offer to open Hive for you.
3. Click **+ Add source** to share a window, screen, webcam, URL or Spout2 sender.
4. Your partner's sources appear in the dashboard. For each one, either:
   - click **Copy URL** and add it to OBS as a **Browser Source**, set to the "OBS size" shown, or
   - turn on **Spout out** and pick it up in OBS with the Spout2 plugin.

## Feedback

Run into any problems testing the pre-release? Let me know in the [issues](https://github.com/dollpuppy/hive/issues)! No formalities needed, just tell me the steps to recreate the problem you're running into.

Wanna see a new feature? Lemme know in [issues](https://github.com/dollpuppy/hive/issues) too :3
