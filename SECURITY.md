# Security Policy

## Supported versions

| Version | Status |
|---------|--------|
| v0.1.0-beta.x | Active development — security fixes applied to `main` |

## Reporting a vulnerability

**DO NOT open a public GitHub Issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting (Security → Report a vulnerability)
or contact the repository owner directly.

**Never post in any public issue or discussion:**
- Torn API keys (yours or anyone else's)
- VAPID private keys
- Session cookies or tokens
- Database dumps or connection strings
- Server logs containing sensitive data

## What to include

- Description of the vulnerability
- Steps to reproduce (if possible)
- Affected component/page/endpoint
- Your assessment of severity

## Response timeline

This is a personal self-hosted project — no SLA is offered. Reports are
triaged on a best-effort basis and fixes are prioritized by severity.
Coordinated disclosure is appreciated: please allow reasonable time for a
fix before public disclosure.

## Security model

TornScope is a self-hosted application. The server operator must be trusted
with data accessible to stored API keys — see the onboarding trust
disclosure for the full model. Session tokens are 32-byte random, stored as
SHA-256 hashes, HttpOnly, SameSite=Lax, Secure on HTTPS, with server-side
absolute (365d) + idle (90d) expiry. All tenant data is isolated per browser
profile; the server owner role provides no cross-user data access.
