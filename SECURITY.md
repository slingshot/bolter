# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Bolter, please report it responsibly via [GitHub Security Advisories](https://github.com/slingshot/bolter/security/advisories/new).

**Please do not open a public issue for security vulnerabilities.**

## Scope

The following areas are considered in-scope for security reports:

- Client-side encryption/decryption logic (key derivation, AES-GCM implementation)
- Encryption key leakage (keys appearing in server logs, network requests, etc.)
- Pre-signed URL generation and validation
- Authentication or authorization bypass
- Server-side data exposure
- Cross-site scripting (XSS) or injection vulnerabilities
- Insecure direct object references (IDOR)

## Out of Scope

- Vulnerabilities in third-party dependencies (report these upstream)
- Denial-of-service attacks
- Social engineering
- Issues that require physical access to a user's device

## Response Timeline

- **Acknowledgment**: Within 48 hours of report submission
- **Initial assessment**: Within 5 business days
- **Resolution target**: Depends on severity, but we aim for 30 days for critical issues

## Disclosure

We follow coordinated disclosure. We ask that you give us reasonable time to address the issue before making any information public.
