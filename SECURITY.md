# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Zero-Dependency Supply Chain Posture

**Vortex (`glastor-core/vortex`)** is engineered with a strict **Zero External Dependency** architecture on Deno 2. It relies exclusively on native runtime APIs (`node:util`, `node:fs`, `node:path`, `node:assert/strict`), eliminating third-party npm/JSR transitive supply-chain risks in CI/CD pipelines.

## Reporting a Vulnerability

If you discover a security vulnerability within **Vortex**, please report it privately to the **GLASTOR® Core Security Team**:

- **Email:** [ventas@glastor.es](mailto:ventas@glastor.es)
- **Website:** [https://glastor.es](https://glastor.es)
- **Lead Maintainer:** [@glastor-dev](https://github.com/glastor-dev) (GitHub Developer Program Member)

We respond to all security reports within 24 hours and release patches within 72 hours of verification.
