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

## Pre-commit hook

Enable the versioned hook once per clone:

```sh
npm run hooks:install
```

The hook runs the public-content scan, dependency audit, strict TypeScript build, and compiled tests. It also scans staged changes with `gitleaks` when the binary is installed. CI always runs the full `gitleaks` scan.

## Repository boundaries

- Keep device addresses, precise coordinates, credentials, exported flows, and deployment state out of the repository.
- Use synthetic values in tests.
- Store Node-RED credentials through credential definitions, never ordinary node properties or emitted messages.
- Keep policy modules deterministic; network, filesystem, and timer work belongs in adapters.
