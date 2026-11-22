# Contributing

## Branch and worktree workflow

`main` accepts pull requests only. Start each change from the current remote
`main` in a separate worktree:

```sh
git fetch origin main
git worktree add -b <type>/<name> ../node-red-home-automation-<name> origin/main
cd ../node-red-home-automation-<name>
npm ci
npm run hooks:install
```

Push the topic branch and open a pull request. GitHub may merge it only after
the required `test` and `private-boundary` checks pass. Pages deployment runs
after the accepted commit reaches `main`; it is not a second acceptance gate.

After GitHub reports the pull request merged, remove the worktree and its local
branch. Squash merging does not make the topic commit an ancestor of `main`, so
the local branch removal is intentionally forced:

```sh
git worktree remove ../node-red-home-automation-<name>
git branch -D <type>/<name>
```

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

## Local hooks

Enable the versioned hooks once per clone or worktree:

```sh
npm run hooks:install
```

The pre-commit hook runs the public-content scan, dependency audit, strict
TypeScript build, and compiled tests. It also scans staged changes with
`gitleaks` when the binary is installed. CI always runs the full `gitleaks`
scan. The pre-push hook rejects direct updates to `main`; merge through the
protected branch instead.

## Releases

Merged `main` changes run CI and publish Pages. Package releases are intentional:

1. Commit the package version and complete the deployment smoke.
2. Create and push the matching `v<version>` tag.
3. The same CI workflow repeats the package gates, validates the tag against
   `package.json`, publishes that tarball to npm through trusted publishing
   (skipped when the version is already on npm), and creates a GitHub Release
   containing the tarball and its SHA-256 checksum.

npm publishing uses GitHub's OIDC token, with no stored npm token. One-time
setup, done once by an npm owner of `@avantics`: publish the first version by
hand with 2FA (npm only accepts a trusted publisher for an existing package),
then on npmjs.com add a GitHub Actions trusted publisher for owner
`avantics-hq`, repository `node-red-home-automation`, workflow `ci.yml` and
environment `npm-publish`, and set publishing access to require 2FA and
disallow tokens.

Documentation-only commits do not receive package tags or releases.

Fixes bump the patch number, and features the minor. For now, breaking changes
also bump the minor version rather than the major, so improvements keep rolling
out; every breaking change is called out under "Behaviour change" in the GitHub
Release notes. Cut a release when a group
of user-noticeable fixes or a feature has merged, not on every merge. The
version-bump pull request updates every place that names the current version:
`package.json`, both root entries in `package-lock.json` (`npm version <x.y.z>
--no-git-tag-version`), the README install line, the version placeholder in
`.github/ISSUE_TEMPLATE/bug.yml`, and the "Package x.y.z" labels in
`docs/index.html`, `docs/contract-examples.html` and `docs/home-theatre.html`.

## Repository boundaries

- Keep device addresses, precise coordinates, credentials, exported flows, and deployment state out of the repository.
- Use synthetic values in tests.
- Store Node-RED credentials through credential definitions, never ordinary node properties or emitted messages.
- Keep policy modules deterministic; network, filesystem, and timer work belongs in adapters.
