# Contributing to Warp

Thanks for your interest in improving Warp!

## Development setup

```bash
npm install
npm start        # builds TypeScript + native helpers, launches the app
```

Hosting requires macOS 13+ (with Screen Recording + Accessibility permissions);
the client runs on Windows or macOS. See the [README](README.md) for details.

## Guidelines

- Keep changes focused and match the surrounding code style — the codebase
  favours small, well-commented modules.
- Run the type check before opening a PR: `npm run build:ts`.
- Don't commit build output (`dist/`, `release/`, `native/bin/`) or secrets. The
  code-signing certificate is generated locally and stored as CI secrets, never
  in the repo.
- By contributing, you agree that your contributions are licensed under the
  project's **LGPL-3.0-or-later** license.

## Reporting bugs & security issues

- Functional bugs: open a GitHub issue with steps to reproduce.
- Security issues: please follow [SECURITY.md](SECURITY.md) and report
  **privately** — do not open a public issue.
