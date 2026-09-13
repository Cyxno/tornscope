# PWA & iOS (Home Screen, Notifications, Service Worker)

TornScope is an installable web app. On iPhone/iPad it becomes a Home Screen
web app with standalone display and (iOS/iPadOS 16.4+) Web Push. This doc is
the source of truth for install flows, platform limits, and the service
worker strategy.

## 1. Installation

| Platform | Flow |
|---|---|
| iPhone / iPad (Safari, Chrome, Firefox — all WebKit) | No native prompt exists. A contextual **Install TornScope** hint (Share → Add to Home Screen) appears for iOS browsers in a normal tab, when not dismissed and not installed. |
| Chromium desktop / Android | The standard `beforeinstallprompt` flow: the hint shows an **Install** button that drives the native prompt. |
| Already installed | The hint never renders (`display-mode: standalone` and/or the `appinstalled` event). |
| Dismissed | Stored in `localStorage` (`tornscope-install-hint-dismissed`) and never re-shown until the storage is cleared. |
| Insecure origins (HTTP) | The hint notes that notifications need a secure context even after installing. |

Placement is contextual only: the hint bar (layout-level), and the
Notifications settings surface when push requires the installed app. It is
dismissable, keyboard-accessible, and never blocks core use.

## 2. Standalone (Home Screen) behavior

- `manifest.webmanifest`: `id: /`, `start_url: /today`, `scope: /`,
  `display: standalone`, maskable + regular icons, dark background and theme
  colors matching the app's dark default.
- iOS meta tags (`apple-mobile-web-app-capable`, status bar style
  `black-translucent`, `apple-mobile-web-app-title`) plus
  `apple-touch-icon` (180×180, opaque) — only currently meaningful tags.
- `viewport-fit=cover` so `env(safe-area-inset-*)` is real in standalone;
  the mobile header pads by the top inset and the bottom tab bar by the
  bottom inset (no-ops in normal browsers, where insets are 0).
- Sessions, theme and deep links all work from the Home Screen icon; the
  session cookie is shared with the browser the app was installed from.
- `start_url: /today` never dumps a connected user into onboarding: the
  first-run redirect only fires for profiles without a connected key.

## 3. Notifications on iOS — the platform reality

Web Push on iPhone/iPad is only available to the **installed Home Screen
app** (iOS/iPadOS 16.4+). A normal browser tab on iOS — Safari, Chrome, or
Firefox (all WebKit views) — does not expose a usable PushManager, and no
user-agent check can conjure one. TornScope's capability model therefore
answers **what the platform can actually do**, feature-first:

| State | Meaning | UI |
|---|---|---|
| `ok` | Secure context + PushManager + Notification + SW | Enable flow available |
| `ios-needs-install` | iOS/iPadOS browser tab, push absent | "Install TornScope on your Home Screen first" + guided steps — never a dead end, never "Firefox doesn't support notifications" |
| `unsupported` | No push even installed (old iOS, desktop without SW) | Honest unsupported wording (iOS version called out when relevant) |
| `insecure` | Not a secure context | Points at the server's configured HTTPS address |
| `sw-failed` | Service worker registration failed | The actual registration error |
| permission `denied` | Blocked in browser settings | Guidance to re-enable in settings; no repeated prompts |

The permission request happens **only** inside the explicit
"Enable notifications" action — never on page load. A capability check
without push support never requests anything.

## 4. Service worker strategy

`static/sw.js` is deliberately **push-only**:

- handles `push` (show notification, privacy-first default copy) and
  `notificationclick` (focus an existing TornScope window, else open the
  target URL);
- `skipWaiting` + `clients.claim()` — a new deployment's worker activates on
  the next load; there is no app-shell cache that could pin a stale version;
- **no fetch handler** — no offline cache. The app is a live dashboard;
  stale caches would be worse than a network miss. Private API responses are
  never cached by the worker, `no-store` responses keep flowing untouched,
  and sessions/profile isolation are unaffected.

**Offline behavior (honest):** without connectivity the app shell still
loads (server-rendered pages need the network; previously loaded client
assets come from the HTTP cache), but data requires the API. Requests fail
with the standard "Could not reach the TornScope API" error — the app never
pretends to be offline-capable.

## 5. Delivery limits

Real device delivery can only be verified on a real iPhone/iPad. The dev
environment proves: subscription registration, storage, the delivery ledger,
and the push-service acceptance of test sends. Anything beyond the push
service accepting the message is documented as UNVERIFIED.
