# Contributing

Contributions are welcome. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities
privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Contributing from a fork

1. Fork the repository and create a branch from `main`.
2. Install and enable the local checks:

   ```sh
   npm ci
   npm run hooks:install
   ```

3. Make your change and run `npm test` (build, unit tests and contract
   examples). If you changed a node or an example flow, also run the Node-RED
   smoke that CI runs, which loads the packed package and every example flow in
   an embedded Node-RED:

   ```sh
   smoke="$(mktemp -d)"
   npm pack --pack-destination "$smoke"
   (cd "$smoke" && npm init -y > /dev/null && \
     npm install --no-audit --no-fund node-red@5.0.10 ./avantics-node-red-home-automation-*.tgz)
   node scripts/node-red-smoke.mjs "$smoke"
   ```

4. Open a pull request against `main` and fill in the template.

### Writing a pull request

The template has the shape; these keep it useful:

- **Open with what it does and why,** in a sentence or two, and link the issue
  it fixes.
- **What changes** is what a user, a flow, an MQTT consumer or a saved node will
  notice, in short plain bullets. Name what is deliberately unchanged where a
  reader might wonder, such as device commands staying the same.
- **Checks** name the commit, the command and what you saw. Include reviewers'
  findings and simulations where they prove something, and say what you couldn't
  run.
- **Keep it to the change and its evidence.** Leave out steps for whoever merges
  it, such as what to do after merging, merge order, tags or releases.
- **Keep it true.** When the change changes, update the description. If a claim
  in it turns out wrong, correct it and say it was wrong.
- **A release pull request** says which version and which merged pull requests
  it contains; the README's release notes carry the detail.

### Code origin

Write your own code. Don't copy or port code from other projects, whatever
their license, and that includes translating it into another language. Say in
the pull request's Origin section what you consulted. Vendor protocol strings
and commands taken from published device documentation are fine.

### Reviewing

When a change contains algorithm-shaped code (curves, maths, tuned constants or
default values), compare it with the well-known projects in that domain: look
for distinctive names, constants and default values that match. A translated
port is easy to miss, and no free scanner catches one.

The required `test` and `private-boundary` checks must pass before a pull
request can merge. Pull requests are squash-merged. Follow the
[repository boundaries](#repository-boundaries): no device addresses, precise
coordinates, credentials, exported flows or deployment state, and synthetic
values in tests and examples.

## Maintainer worktree workflow

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

The public-content scan rejects credential-like files, private network addresses (IPv4, CGNAT, private IPv6, .local and .lan names), MAC addresses, email addresses outside reserved example domains, Zigbee IEEE addresses, Home Assistant entity ids, Zigbee2MQTT device topics, absolute user-home paths, high-precision coordinates, exported flow identifiers, and private-key blocks.

### What never goes in a commit

This repository holds reusable controller code and general delivery status, never a
real installation. Keep these out of commits, examples, tests and issues:

- live flows exported from a real Node-RED instance;
- private hostnames and IP addresses;
- Home Assistant entity IDs from a real home;
- backup paths and other local file paths;
- credentials, tokens and pre-shared keys;
- infrastructure and operations details.

Use synthetic names and addresses instead. `npm run scan:public` catches the
machine-detectable cases; the rest is up to the author and the reviewer.

### Documentation site

The pages in `docs/` are built, not edited by hand. Change the page content in
`docs-src/pages/` or the menu in `docs-src/nav.json`, then run `npm run docs`
and commit both. `npm test` fails when `docs/` doesn't match its build.

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
   `package.json`, stages that tarball on npm through trusted publishing
   (skipped when the version is already on npm), and creates a GitHub Release
   containing the tarball and its SHA-256 checksum.
4. A maintainer approves the staged version with 2FA, on npmjs.com (the
   package's Staged Packages tab) or with `npm stage approve <stage-id>`. The
   npm version is live only after approval.

npm staging uses GitHub's OIDC token, with no stored npm token. One-time setup,
done once by an npm owner of `@avantics`: publish the first version by hand with
2FA (npm only accepts a trusted publisher for an existing package), then on
npmjs.com add a GitHub Actions trusted publisher for owner `avantics-hq`,
repository `node-red-home-automation`, workflow `ci.yml` and environment
`npm-publish`, allowing staged publishing only, and set publishing access to
require 2FA and disallow tokens.

Documentation-only commits do not receive package tags or releases.

Fixes bump the patch number, and new nodes and features the minor. A change
that a flow, a saved node or an installation must act on, such as raising the
Node.js version the package needs or removing an old unit or setting name,
bumps the major. An old form keeps working through the rest of its major series,
with a warning where possible, and is removed in the next major. Cut a release
when a group of user-noticeable fixes or a feature has merged, not on every
merge. The version-bump pull request updates every place that names the current
version: `package.json`, both root entries in `package-lock.json` (`npm version
<x.y.z> --no-git-tag-version`), the README install line and the version
placeholder in `.github/ISSUE_TEMPLATE/bug.yml`, and adds the release's notes to
the README. A major release also adds its section to
`docs-src/pages/releases.html`: what changed and why, what to do when
upgrading, and what is deprecated for the next major (a test checks each major
from 5 has one). Then run `npm run docs`, which writes the new version into every
documentation page.

## Repository boundaries

- Keep device addresses, precise coordinates, credentials, exported flows, and deployment state out of the repository.
- Use synthetic values in tests.
- Store Node-RED credentials through credential definitions, never ordinary node properties or emitted messages.
- Keep policy modules deterministic; network, filesystem, and timer work belongs in adapters.
