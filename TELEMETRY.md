# OpenGPEX Update Check & Telemetry

OpenGPEX is committed to user privacy and open-source transparency.

To notify you of new releases and critical security patches, OpenGPEX checks for updates with a lightweight anonymous ping. The same ping doubles as an aggregate activity counter (how many browsers use which versions), which guides development priorities.

This document outlines **what data is collected**, **what is never collected**, and **how you can opt out**.

---

## 1. Why Telemetry?

As an open-source project, telemetry tied to update checking helps us:

- **Alert you to new releases**: Delivers changelogs, performance improvements, and security patches directly to your browser.
- **Measure adoption**: Understand aggregate daily/monthly active browsers and version distribution — never individuals.

---

## 2. What Is Collected

A check fires when the page loads (3s delay, at most once per 12 hours per browser) or when you click "Check for Updates". The request goes to your own deployment's local server route first, which relays it to `gpex.cloud` with the following fields:

| Field                       | Example                               | Source                                                                                                   | Purpose                                                                                                                                                                |
| :-------------------------- | :------------------------------------ | :------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_id`                 | `c4b8e219-...` (UUID v4)              | Random, generated once in your browser `localStorage`; also shown in the CloudMenu panel                 | Distinguishes browsers (one id = one browser = one anonymous user). The server stores only a salted one-way SHA-256 hash of it — the raw id never touches the database |
| `current_version`           | `2.0.0-beta.10`                       | The running OpenGPEX version                                                                             | Matches against the latest released version                                                                                                                            |
| `client_os`                 | `darwin`, `win32`, `linux`, `unknown` | Your browser self-reports via the standard User-Agent Client Hints API; falls back to User-Agent parsing | Aggregate "which platforms do our users run on"                                                                                                                        |
| `client_arch`               | `arm64`, `x64`, `unknown`             | Same as above (2-value enum, not a fingerprint)                                                          | Aggregate platform statistics                                                                                                                                          |
| `server_os` / `server_arch` | `linux`, `x64`                        | The deployment host itself (`node:os`)                                                                   | Self-hosted environment analysis                                                                                                                                       |
| `deployment`                | `cloud` / `self_hosted`               | Server-side decision from the official host list                                                         | Distinguishes official cloud from self-hosted                                                                                                                          |
| `country`                   | `US`, `CN`, ...                       | Coarse country code from the edge (`CF-IPCountry`), read server-side                                     | Regional adoption aggregate                                                                                                                                            |

The check never blocks the UI and silently degrades to "no update" on any network failure.

---

## 3. What Is NEVER Collected

OpenGPEX respects your privacy and strictly enforces a negative data collection policy:

- ❌ **No Personal Identifiable Information (PII)**: No usernames, emails, or personal accounts.
- ❌ **No File or Image Data**: Your images, layers, brushes, masks, and metadata **never leave your device**.
- ❌ **No Local Hostnames or Internal IPs**: We never transmit private domain names or local network addresses.
- ❌ **No Raw IPs Anywhere**: The connecting public IP is masked (`/24`) server-side, used only for an abuse guard, and never persisted or logged alongside any identifier.
- ❌ **No Fingerprinting**: We collect a 3-value architecture enum, not high-entropy device signals. There is no way to single out an individual browser from this data.
- ❌ **No Cookies or Cross-Site Tracking**: The client id lives in your browser's `localStorage`, is sent only to your own deployment, and never leaves the stats database except as a salted hash.

---

## 4. How to Opt Out

You can disable automatic update checks and telemetry at any time:

1. Open OpenGPEX in your browser.
2. Open **Preferences** (from the main `ToolMenu`).
3. Toggle **Automatic Update Checks** to **OFF**.

Self-hosted operators can additionally block all outbound checks server-side, regardless of browser preferences:

```bash
DO_NOT_TRACK=1
```

## Questions or Feedback?

If you have any questions, concerns, or audit requests regarding our telemetry practices, please open an issue or discussion on GitHub:
👉 [https://github.com/OpenGPEX/opengpex/issues](https://github.com/OpenGPEX/opengpex/issues)
