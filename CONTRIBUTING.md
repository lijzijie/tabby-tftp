# Contributing

Thanks for helping improve Tabby TFTP.

## Local setup

Use Node.js 18 or newer, then install dependencies and run the complete verification suite:

```powershell
npm ci
npm run verify
```

The source is TypeScript. Protocol behavior is covered by the tests in `tests/`; UI changes should also be checked in a local Tabby installation.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update tests for protocol and server behavior.
- Update `README.md`, `README.zh-CN.md`, and `CHANGELOG.md` when behavior or configuration changes.
- Do not commit generated `dist/`, `.tgz` packages, local settings, credentials, or firmware binaries.
- Make sure `npm run verify` passes before opening a pull request.

## Commit messages

Short, imperative messages are preferred, for example `Fix server lifetime after modal close` or `Add retry test for duplicate ACK`.
