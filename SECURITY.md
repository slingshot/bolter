# Security Policy

## Encryption Model

Bolter offers **optional end-to-end encryption** that users can enable per upload. When encryption is toggled on, the architecture is **zero-knowledge** — the server never has access to plaintext files or encryption keys. When encryption is off, files are uploaded as-is for simpler, faster sharing.

### How Encryption Works (When Enabled)

1. **Key generation** — a random 128-bit secret is generated client-side via `crypto.getRandomValues()`
2. **Key derivation** — HKDF (HMAC-based Key Derivation Function) derives separate keys for content encryption and metadata from the single secret
3. **Encryption** — files are encrypted with **AES-128-GCM** in 64KB records using the Web Crypto API, enabling streaming encryption/decryption without loading entire files into memory
4. **Upload** — only ciphertext is uploaded to S3/R2 via pre-signed URLs; the server never handles file data
5. **Sharing** — the encryption key is placed in the URL hash fragment (`#`), which browsers never include in HTTP requests

> **Note**: Without encryption enabled, files are uploaded in plaintext to S3/R2. The server still never handles file data directly (uploads go through pre-signed URLs), but the storage provider can read the file contents.

### What the Server Knows

- That a file exists (opaque ID)
- File size (when encrypted: ciphertext size, slightly larger than plaintext due to GCM tags)
- When the file was uploaded
- Expiration time and remaining download count
- Whether encryption was enabled for the upload

### What the Server Does NOT Know (When Encrypted)

- File contents
- File name or type
- Encryption key
- Who uploaded or downloaded the file

> When encryption is **not** enabled, the storage provider (S3/R2) can access file contents. The Bolter backend still does not read or process file data in either case.

### Trust Boundaries

| Boundary | Trust Level |
|----------|-------------|
| Browser (frontend code) | Must be trusted — it handles encryption |
| Server (backend) | Untrusted for file content — only manages metadata |
| S3/R2 storage | Untrusted — stores only ciphertext |
| Redis | Untrusted for secrets — stores only metadata (IDs, TTLs, counters) |
| Network (TLS) | Standard HTTPS — protects transport, not needed for file confidentiality |

### Limitations

- **Link security is key security** — anyone with the full share link (including the hash fragment) can decrypt the file. Protect the link as you would a password.
- **Browser trust** — the encryption runs in the browser. If the frontend code is compromised (e.g., via a supply chain attack), encryption guarantees are void.
- **No forward secrecy** — if a key is compromised, all files encrypted with that key are compromised.
- **Metadata visibility** — the server knows file sizes, upload times, and access patterns even though it can't read contents.

## Reporting a Vulnerability

If you discover a security vulnerability in Bolter, please report it responsibly:

**Preferred**: [GitHub Security Advisories](https://github.com/slingshot/bolter/security/advisories/new)

**Please do not open a public issue for security vulnerabilities.**

## Scope

The following areas are in-scope for security reports:

- Client-side encryption/decryption logic (key derivation, AES-GCM implementation)
- Encryption key leakage (keys appearing in server logs, HTTP requests, referrer headers, etc.)
- Pre-signed URL generation and validation
- Server-side data exposure or access control bypass
- Cross-site scripting (XSS) or injection vulnerabilities
- Insecure direct object references (IDOR)
- Metadata leakage beyond what's documented above

## Out of Scope

- Vulnerabilities in third-party dependencies (report these upstream)
- Denial-of-service attacks
- Social engineering
- Issues that require physical access to a user's device
- Brute-force attacks against the encryption (AES-128-GCM is considered secure)

## Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Resolution (critical) | Target 30 days |
| Resolution (other) | Target 90 days |

## Disclosure

We follow coordinated disclosure. We ask that you give us reasonable time to address the issue before making any information public.
