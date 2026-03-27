# Valu — product overview

This document captures positioning, privacy, and feature context for Valu (PWA). Use it for marketing, onboarding copy, and partner conversations.

---

## One-line positioning

**Valu is a mobile-first personal finance web app that stores each group’s data in a Google Spreadsheet in *your* Google account—so you keep ownership, portability, and clarity about where your numbers live.**

---

## The problem

Many finance apps hide your data inside their own databases. Users who already rely on Google want **simple tracking** (accounts, spending, income, balances) **without** surrendering their ledger to an opaque backend—or they want the option to treat their data like **real files they control**.

---

## What Valu is

- A **progressive web app (PWA)** you open in the browser (and can install). It provides structured screens for **groups**, **accounts**, **expenses**, **income**, and **balance history**, with a **home** view for summaries and charts where enabled.
- Each **group** is backed by a **Google Spreadsheet** that Valu **creates** in **your** Google Drive when you connect. The app reads and writes that sheet through **Google’s APIs** using **your** Google sign-in.

---

## Privacy & data ownership (plain language)

**You own your data.** Your spreadsheets live under **your** Google account. You can open them in Google Sheets, export them, copy them, and manage them like any other file you own.

**Private by design — for your eyes only.** The sensitive rows are not routed through a separate “Valu server” that stores your transactions. The **web app running in your browser** talks **directly to Google** (Sheets / Drive) with the permissions you grant. Nothing about that model requires Valu the **product/company** to receive, aggregate, or host your financial history on its own systems for the app to work.

**Why we still say “only spreadsheets Valu creates.”** That phrase refers to **OAuth scope**: the integration is built so the app only needs access to **spreadsheets this app created** in your Drive—not your entire Drive. It is **not** meant to imply that “the company reads your sheet.” The access path is: **your device → Google’s APIs → your spreadsheet.** Clarify this in user-facing copy so people do not confuse **app permissions** with **corporate access**.

**Short trust line (example):**  
*Your finances stay between you and Google. Valu runs in your browser and syncs to spreadsheets in your account—nothing is sent to Valu to hold your ledger.*

---

## How it works (technical, user-safe summary)

1. You **sign in with Google** so the app can create and update **specific** spreadsheets on your behalf.
2. Valu creates a spreadsheet per **group** (naming like `Valu: …`) with tabs for settings, accounts, expenses, income, and balance history.
3. Day-to-day use triggers **API calls from your session** to read/write those tabs. **Quota and storage** are Google’s; **you** stay the account owner.

---

## Differentiators

| Theme | Message |
|--------|---------|
| **Ownership** | Data lives in **your** Drive as standard spreadsheets. |
| **Transparency** | You can inspect the same numbers in Google Sheets that the app shows. |
| **Minimal surface** | OAuth scoped so the app does not ask for blanket access to unrelated files. |
| **Try first** | **Quick look** / demo lets people explore the UI with sample data before signing in. |
| **Modern UX** | Mobile-first shell, side nav, sheets-style modals; brand motion (orbs, wordmark) aligned with valu-app.com. |

---

## Core features (product)

- **Groups** — Multiple independent workspaces (each with its own spreadsheet).
- **Accounts** — Multiple accounts, currencies, ordering, discontinued accounts.
- **Expenses & income** — Amount, account, category, date, notes; configurable categories in settings.
- **Balance history** — Track balances over time; supports net-worth style views on Home.
- **Home** — Monthly rollups, charts where enabled; **multi-currency** via base currency and optional rates in settings.
- **Settings per group** — Enable/disable feature lists (e.g. expenses, income, accounts), group name, categories, rates.

---

## Honest scope / expectations

- **Longevity:** Google Sheets is a durable place to keep years of history; the client loads full tabs today, so **very large** histories may eventually warrant UX/performance improvements (pagination, ranges, etc.)—not a “wrong” model for typical personal use.
- **APIs:** Usage is subject to **Google Cloud quotas** for the OAuth project; normal personal use is unlikely to be the issue; **concurrent** traffic across many users is what projects plan for.
- **Version:** Ship honest labeling (e.g. early version) where the app shows it.

---

## Brand & experience cues

- **Visual:** Orb / sphere motif, wordmark, teal-forward palette (e.g. theme `#729c9c`), **Lato**, clean cards.
- **First run:** Welcome + **Quick look**; sign-in via **Connect with Google** when ready—not a wall before understanding the product.

---

## Suggested CTAs

- **Try Quick look** / **Open the app** (demo path).
- **Connect with Google** when saving real data.
- Link out to **https://valu-app.com/** for the broader marketing site where appropriate.

---

## Revision note

Earlier copy sometimes said *“Valu can only access spreadsheets it creates.”* That is accurate for **API scope** but easy to misread as **“the company can access my sheet.”** Prefer language that stresses **your browser**, **your Google account**, **you own the file**, and **private by design**—with scope explained as **least access**, not corporate surveillance.
