# TornScope 1.0.0

TornScope's first stable release. One year of continuous development across
every surface — analytics, financial reporting, notifications, and the
self-hosting experience — is now certified against live production data.

The production environment is labeled **PUBLIC TESTING**: the software
version is 1.0.0 while the hosted service continues to grow with public
feedback.

## Highlights

**Wealth-first financial reporting.** Every financial page now leads with
what actually matters: your net worth change first, then the true economic
result (real income vs. real costs), then asset conversions and wallet
movement as clearly-labeled neutral context. Cash moving into items,
stocks or the bank is movement between forms — it is never presented as a
loss, and sale proceeds are never presented as profit. Red and green are
reserved for real economic meaning; a big wallet outflow next to a rising
net worth now reads exactly as it should.

**Overview and Today, rebuilt around the story.** The Overview opens with
the net-worth hero and its drivers, with a plain-language explanation of
your period. Today pairs the live account status with a dated Daily
Summary — cash flow, economic effect, conversions, training, travel and
the "why it moved" ledger — backed by a dual reconciliation: your wealth
story and your wallet arithmetic are each honest about what they can and
cannot explain.

**Full historical analytics.** Economy, Progression, Combat, Crimes,
Travel, Drugs, Stocks, Merits, Faction — every route has period-aware
summaries, provenance and confidence badges, and a raw ledger underneath.
Training inference reconstructs sessions, gym-attributable gains and happy
jumps from bars and stats history; Xanax funding is classified by evidence
(faction-sponsored vs. personal) rather than guessed.

**Local time and Torn time.** Display every timestamp in your own timezone
or Torn's UTC — per your choice, with alternate-zone tooltips on significant
moments. The Today page follows your profile's calendar day; range analytics
follow Torn's UTC day. Daylight saving is handled per event.

**Range intelligence.** Pages remember their own date range; a Settings
default governs first visits; custom ranges are explicit Torn-day windows.

**Notifications and PWA.** Push notifications with quiet hours, deferral
and per-type control; installable as a PWA; installable clients keep their
own appearance and notification settings per browser.

**Multi-profile and security foundations.** Anonymous browser-bound
profiles, encrypted-at-rest Torn API keys (AES-256-GCM), explicit profile
linking between devices, per-route rate limiting, CSRF origin checking,
strict demo isolation, and a hardened single-node deployment contract.

**Demo environment.** A clearly-labeled synthetic dataset with 180 days of
deterministic history that automatically extends toward the present, so
visitors always see a living account.

**Self-hosting.** Docker-first deployment with a hardened production deploy
script (build-identity verification, migration gating, readiness probes),
full test suite, and documented release/rehearsal procedures.

## Honesty notes

- Push delivery is exercised end-to-end by the product and tested against
  the Web Push protocol; we have not exhaustively verified every real
  iOS/Android vendor combination on physical devices.
- Some analytics (travel profit, consumption value) are estimates by
  nature; TornScope always marks them and never presents estimates as
  exact figures.
