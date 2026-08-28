# Third-party notices

Sift AI is licensed under Apache License 2.0. It depends on third-party software
distributed under its own licenses.

The direct external dependencies and development tools currently include:

| Component | Purpose | Declared license |
|---|---|---|
| Electron | Windows desktop runtime | MIT |
| electron-builder | directory packaging | MIT |
| electron-builder-squirrel-windows | pinned Windows packaging compatibility tool | MIT |
| esbuild | extension and desktop bundling | MIT |
| linkedom | deterministic offline DOM projection | ISC |
| Zod | runtime schema validation | MIT |
| Ajv | JSON Schema test/validation tooling | MIT |
| TypeScript | type checking | Apache-2.0 |
| ESLint and typescript-eslint | static analysis | MIT |
| Vitest | automated tests | MIT |
| Chrome and Node type definitions | development types | MIT |

The lockfile also contains transitive packages under MIT, ISC, Apache-2.0,
0BSD, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, Python-2.0, WTFPL, and
permissive multi-license expressions. Generate the installed dependency report
for the exact lockfile with:

```powershell
pnpm licenses list
```

Before distributing a binary, preserve the license and notice files shipped by
Electron, including Chromium's `LICENSES.chromium.html`, and review the report
for the exact build being distributed. This file is an inventory aid, not a
replacement for third-party license texts or legal review.
