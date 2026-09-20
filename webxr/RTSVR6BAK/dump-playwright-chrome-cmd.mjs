#!/usr/bin/env node
/** Dump the real Chrome command line Playwright uses for the bench profile. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const profile = path.join(ROOT, '.chrome-openxr-vd-poses');

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio'],
});
await new Promise((r) => setTimeout(r, 2500));

const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
  Where-Object { $_.CommandLine -match 'openxr-vd-poses' -and $_.CommandLine -notmatch '--type=' } |
  ForEach-Object { $_.CommandLine }
`;
const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', ps], {
  maxBuffer: 5 * 1024 * 1024,
});
console.log('PLAYWRIGHT CHROME CMD:\n' + stdout.trim());
await ctx.close();
