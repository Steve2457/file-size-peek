# File Size Peek 0.1.0 validation — 2026-11-05

- `npm test`: 12 tests passed on Windows with Node.js 22.23.4.
- Real filesystem checks cover exact file sizes, nested and hidden files/folders, Unicode names, empty files/folders, hard links and a directory junction pointing back to the scan root.
- A 2,500-file fixture verifies all files are counted with at most 16 metadata reads in flight. Cancellation closes the directory handle and drains outstanding reads.
- Read failures produce partial results, with error details capped at 20 entries.
- VS Code API harness checks Explorer command registration, remote paths, Chinese/English notifications, copy/details actions, cancellation, error messages, active-editor fallback and superseding an earlier scan.
- `node --check extension.js` and `node --check size.js` passed.
- `@vscode/vsce@4.1.0 package` succeeded. Installable package identity: `v-junanhu.file-size-peek`, version 0.1.0; no runtime dependencies. Test files are excluded.
- Native VS Code UI and a live SSH extension host have not been exercised. Nothing was installed into the user's VS Code profile or published to Marketplace.
