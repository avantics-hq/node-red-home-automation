# Contributing

## Local checks

Install dependencies and run the same package checks used by CI:

```sh
npm ci
npm run scan:public
npm audit --audit-level=high
npm test
```

The public-content scan rejects credential-like files, private network addresses, absolute user-home paths, high-precision location defaults, and private-key blocks.

## Public reports and dependency updates

Use the structured bug-report form for reproducible package defects. Security
reports must follow [SECURITY.md](SECURITY.md) and remain private until a fix is
available. Public evidence must use synthetic identifiers and omit installation
topology.

Dependabot checks npm and GitHub Actions weekly. Action dependencies remain
pinned to immutable commit revisions; the adjacent version comments document
the reviewed release.

## Pre-commit hook

Enable the versioned hook once per clone:

```sh
npm run hooks:install
```

The hook runs the public-content scan, dependency audit, strict TypeScript build, and compiled tests. It also scans staged changes with `gitleaks` when the binary is installed. CI always runs the full `gitleaks` scan.

## Releases

`main` pushes run CI and publish Pages. Package releases are intentional:

1. Commit the package version and complete the deployment smoke.
2. Create and push the matching `v<version>` tag.
3. The same CI workflow repeats the package gates, validates the tag against
   `package.json`, and creates a GitHub Release containing the package tarball
   and its SHA-256 checksum.

Documentation-only commits do not receive package tags or releases.

## Repository boundaries

- Keep device addresses, precise coordinates, credentials, exported flows, and deployment state out of the repository.
- Use synthetic values in tests.
- Store Node-RED credentials through credential definitions, never ordinary node properties or emitted messages.
- Keep policy modules deterministic; network, filesystem, and timer work belongs in adapters.
