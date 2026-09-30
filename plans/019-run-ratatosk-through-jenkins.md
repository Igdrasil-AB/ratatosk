# Plan 019: Make Jenkins the Ratatosk CI and release authority

> **Executor instructions**: Use a clean Ratatosk worktree and separate clean
> `igdrasil-accounting` worktree for controller-owned jobs. Implement in phases.
> Keep GitHub Actions and its required checks until equivalent Jenkins checks
> are terminal green on the same PR head. Never bind publishing or code-scanning
> upload credentials in a branch-authored Jenkinsfile. Update `plans/README.md`
> only after each phase has the evidence named below.
>
> **Drift check**: From Ratatosk, run `git diff --stat c74927d..HEAD --
> Jenkinsfile package.json .nvmrc .github/workflows scripts/test-chrome-discovery.ts
> scripts/publish-collector-release.sh scripts/validate-semantic-dom-acceptance.ts
> store/submission-process.md store/release-checklist.md README.md docs/testing.md`.
> From `igdrasil-accounting`, compare current `origin/main` with planning SHA
> `2daf8b390` for `infra/jenkins/jobs/`, `infra/jenkins/casc.yaml`, and
> `infra/jenkins/plugins.txt`. Re-read changed code before following this plan.

## Status

- **Priority**: P0
- **Effort**: L, across two repositories and Jenkins/GitHub configuration
- **Risk**: HIGH; branch protection, privileged publication, and CodeQL cutover
- **Depends on**: none; finish this before Plan 020 uses Jenkins as a gate
- **Category**: CI, security, release
- **Planned at**: Ratatosk `c74927d`, `igdrasil-accounting` `2daf8b390`, 2026-09-30
- **Status**: IN PROGRESS — local jobs and checks built; live Jenkins and protection cutover pending

## Local implementation evidence (2026-10-01)

- Ratatosk CI commit `3248a1e`, trusted controller commit `1c940b9e5`, and
  combined Ratatosk commit `3f2d31d` are local and clean. They have not been
  pushed or deployed.
- Jenkins's live Declarative linter accepted the three pipeline files. A local
  controller image with dummy keys loaded JCasC, created the `ratatosk` folder,
  and placed both App credentials on that folder. The test controller and its
  temporary volume were removed afterward.
- The exact pinned Node 20/22/24 containers each passed 968 tests and emitted
  JUnit with zero failures. The final pinned Playwright container passed 13
  discovery and 10 acquisition cases with zero JUnit failures, then verified
  the Collector ZIP. An earlier run failed in blind acquisition and another
  crashed before Chrome startup; disabling headless GPU passed three full
  acquisition runs and the final full stage. The real Jenkins agent still needs
  its own terminal evidence.
- The pinned CodeQL ARM64 bundle passed its checksum, analyzed Ratatosk main
  `c74927d` (248 JS/TS files and three workflows), and produced a validated
  SARIF with zero findings. This was a local unprivileged analysis, not a
  GitHub upload or Jenkins check.
- Main protection still requires four GitHub Actions contexts with
  `strict: true`. The scoped GitHub Apps, controller deployment, same-head
  terminal Jenkins runs, private live receipt, release publication, and
  protection cutover remain outstanding.

## Goal and current state

Every automated Ratatosk PR/main check, CodeQL analysis, and GitHub release
must have a Jenkins-owned terminal result tied to the exact commit. The human
live-supplier and Chrome Web Store review remain explicit gates; Jenkins must
record their exact artifact evidence rather than pretending fixtures can replace
supplier subscriptions.

- Ratatosk has **no `Jenkinsfile`**. `.github/workflows/ci.yml` runs Node
  20.19.0, 22.12.0, and 24, plus a separate built Chromium discovery/acquisition
  job. `.github/workflows/codeql.yml` analyzes JavaScript/TypeScript.
  `.github/workflows/release-collector.yml` rebuilds and publishes a `v*` tag.
- `package.json` already owns `ci`, `audit:security`, `validate:release`,
  `build:collector`, `package:collector`, `verify:collector-artifact`, and
  `validate:collector-release`. Extend these commands rather than duplicating
  product policy in Groovy. `.nvmrc` is **24**; the Node 22 wording in
  `store/submission-process.md` is stale.
- `scripts/test-chrome-discovery.ts` emits closed synthetic case results to
  stdout but no JUnit. `vitest` supports a built-in JUnit reporter.
- `store/semantic-dom-acceptance.json` is ignored by Git and must match the
  exact ZIP SHA, revisions, and recent three-family/ClickUp live acceptance.
  A fresh tag checkout cannot acquire it by rebuilding alone. A release job
  must consume a privately supplied, checksum-bound receipt and promote the
  **same candidate ZIP** that was tested.
- Current `igdrasil-accounting` `infra/jenkins/jobs/igdrasil-org.groovy`
  automatically discovers organization repositories with a root Jenkinsfile,
  builds org PR merge revisions (not forks), and posts `igdrasil-ci` checks.
  The controller JCasC lists job files explicitly in `infra/jenkins/casc.yaml`.
  Branch-authored Jenkinsfiles must not receive new privileged credentials.
- At planning time, Ratatosk `main` protection has `strict: true` and four
  **GitHub Actions** required checks: Node 20.19.0, 22.12.0, Node 24, and
  Analyze JavaScript and TypeScript. The Chromium job is not currently required.
  Re-query protection before changing it; this snapshot can drift.

Official references: [Jenkins Organization Folders](https://www.jenkins.io/doc/book/pipeline/multibranch/),
[SCM credential trust](https://www.jenkins.io/doc/book/security/securing-org-folders-and-multibranch-pipelines/),
[JUnit/artifact publication](https://www.jenkins.io/doc/pipeline/tour/tests-and-artifacts/),
[Vitest JUnit](https://vitest.dev/guide/reporters),
[Playwright CI](https://playwright.dev/docs/ci), and
[CodeQL in external CI](https://docs.github.com/en/code-security/tutorials/customize-code-scanning/upload-results).

## Commands and scope

| Purpose | Command | Expected |
| --- | --- | --- |
| Product baseline | `npm ci && npm run ci && npm run audit:security && npm run validate:release` | Exit 0 on supported Node |
| Browser gate | `npm run build:collector && npm run test:chrome-discovery:built && npm run test:chrome-acquisition:built` | Every synthetic case passes in the built extension |
| Package smoke | `npm run package:collector && npm run verify:collector-artifact` | Exact versioned ZIP/checksum verified |
| Source gate | `npm run assert:release-source` | Exit 0 only from clean committed source |
| Protection readback | `gh api repos/Igdrasil-AB/ratatosk/branches/main/protection --jq '.required_status_checks'` | Exact current required check names and app IDs |

**Ratatosk in scope**: new root `Jenkinsfile`; small CI reporting changes in
`scripts/test-chrome-discovery.ts` and/or `scripts/ci/`; Jenkins contract tests
under `test/core/`; `package.json` only if a shared command is needed;
`README.md`, `docs/testing.md`, `store/submission-process.md`,
`store/release-checklist.md`, and the three `.github/workflows/` files at
the final cutover. Preserve `scripts/package-extension.ts`, release source,
manifest, and live receipt validation semantics.

**Controller in scope**: a trusted Ratatosk CodeQL upload job and a trusted
Ratatosk release job in `igdrasil-accounting/infra/jenkins/jobs/`, their JCasC
entries/tests, and the minimum scoped Jenkins credentials. Do not add a token
to Ratatosk source or the PR job.

**Out of scope**: supplier-specific tests, automatic Chrome Web Store
publication, loosening the live receipt, new recipe behavior, and running
real supplier credentials in CI.

## Steps

### 1. Enroll Ratatosk without a privileged credential

Add a root `Jenkinsfile` using `checkout scm`, bounded timeouts, timestamps,
concurrency/retention policy, and the existing `dagger` agent label. Run the
same Node 20.19.0/22.12.0/24 matrix as the GitHub workflow in pinned Linux
containers. On Node 24 (the `.nvmrc` release runtime), also run the built
Chromium gates in a Playwright image matching the lockfile's `playwright-core`
version, build/package, and verify the ZIP. Pin image digests after confirming
them on the Jenkins agent. Do not skip browser work on PRs or accept an empty
test population. Keep PR/main Jenkins stages free of Chatwoot, GitHub release,
CodeQL upload, or production credentials.

Emit bounded JUnit for Vitest and each built-browser case; publish it from a
Jenkins `post { always { ... } }` block with `allowEmptyResults: false` and
preserve the failing shell exit code. Archive only sanitized reports and the
package checksum on PRs; do not archive fixture pages, profiles, invoices, or
private acceptance receipts. Add a static pipeline contract test analogous to
the current `test/core/release-workflow-policy.test.ts`.

**Verify**: local product baseline and browser commands above pass; Jenkins
discovers a branch/PR job from the new root file; the PR merge SHA gets one
terminal `igdrasil-ci` check with nonempty JUnit and no credential binding.
If organization discovery requires a root file already on default branch,
bootstrap only that non-privileged Jenkinsfile through the existing required
GitHub Actions gate, then continue. Do not change protection yet.

### 2. Move CodeQL without exposing an upload token to PR code

The Ratatosk PR Jenkinsfile requests and waits for a **controller-owned**
CodeQL job using the PR number and intended merge SHA. The trusted job
independently reads the PR from GitHub and refuses a SHA that is not its current
merge revision. Its unprivileged agent checks out that SHA, runs a pinned
CodeQL CLI JavaScript/TypeScript analysis, and stashes only bounded SARIF.
On a separate clean agent, the trusted job unstashes only SARIF, verifies the
repository/ref/commit and report shape, and uploads it using a Ratatosk-only
GitHub App credential with code-scanning permission. No PR code or build
script runs while that credential is bound. The trusted job posts its own
terminal check; omitting the trigger from a malicious PR leaves that required
check absent, so the PR remains blocked. Model the controller job after
`infra/jenkins/jobs/production-quality.groovy` while keeping its permission
narrower. Use the official CodeQL CLI upload path with
`--github-auth-stdin`; never place a token in argv, SARIF, or Jenkins logs.

**Verify**: one synthetic safe PR yields a Jenkins CodeQL check and a visible
GitHub code-scanning analysis for the exact PR SHA; one malformed/missing SARIF
and one mismatched SHA fail the trusted job. Confirm the GitHub App's installed permissions before
removing `.github/workflows/codeql.yml`. Keep the existing GitHub CodeQL job
required until the Jenkins equivalent is terminal green.

### 3. Separate candidate build from privileged release promotion

Create a controller-owned Ratatosk release job. Its unprivileged stage checks
out an exact protected-main SHA, confirms `v<package.version>`, runs clean
source/CI/security gates, builds one deterministic Collector ZIP/checksum, and
archives them as a **candidate**. The operator runs the existing live-supplier
flow against that exact candidate and supplies only the ignored sanitized
`semantic-dom-acceptance.json` through a private handoff, with the tested ZIP
SHA and commit recorded. The trusted promotion stage revalidates the receipt
against the archived ZIP, seven-day freshness, runtime revisions, and all
three-family/ClickUp/Igdrasil/first-immediate-cadence gates. It never rebuilds
after this match. Keep the receipt out of public Jenkins artifacts/logs.

Only after these checks and an explicit operator approval may a separate,
Ratatosk-scoped GitHub App credential create or verify the `v*` tag/release and
upload the **archived exact ZIP plus `.sha256`**. The credential is bound only
in the trusted publishing stage, on a clean agent with no branch-controlled
code. Update `scripts/publish-collector-release.sh` only as needed to accept
the exact artifact/tag passed by this job; preserve its single-asset-pair and
existing-release byte-comparison checks. Record the GitHub release URL and
checksum in Jenkins. Chrome Web Store upload/review stays a separate human
handoff using the same ZIP; do not claim it was published from a GitHub release.

**Verify**: fake receipt, stale receipt, wrong ZIP SHA, wrong tag/version,
non-main SHA, second ZIP, and missing approval all prevent publication. A
synthetic dry run with a fake `gh` command proves one publish call with the
exact candidate bytes. A real release is attempted only after the approved
live receipt exists and the trusted job is reviewed.

### 4. Cut over protected checks atomically

Dual-run GitHub Actions and Jenkins until the same PR head has terminal green
Node matrix, Chromium, CodeQL, and package evidence in Jenkins. Read back the
Jenkins check's **app ID and exact context**; do not guess that `igdrasil-ci`
alone is the name GitHub protects. Update Ratatosk branch protection in one
controlled operation, preserving `strict: true`, to require the Jenkins PR
check and trusted CodeQL check. Immediately read back the policy and rerun a
new PR head to prove merge blocking. Only then remove the old CI and CodeQL
workflows. Remove the tag workflow only after the trusted Jenkins release job
has an exact-artifact dry run and authorized publication path. Keep Dependabot
for proposals; Jenkins validates its in-org PRs.

Update README/testing/submission docs so Jenkins is the automated authority,
Node 24 is the documented release runtime, the live receipt remains private,
and the Web Store state is reported separately. Inspect one failed PR, one
green PR, main, and tag/release in Jenkins/GitHub before declaring cutover.

**Verify**: `gh api` protection readback shows only the intended Jenkins app
contexts; an intentionally failed PR cannot merge; terminal Jenkins success
on the fresh head makes the PR mergeable; no required GitHub Actions check is
left orphaned. Report queued/running builds as pending, never green.

## STOP conditions

- Jenkins organization discovery is not active for Ratatosk or the agent
  cannot run pinned Node/Chromium images.
- A fork PR is discovered, a branch-authored stage can access publish/SARIF
  upload credentials, or the trusted job cannot verify the exact commit.
- JUnit or Chromium case reports are absent/empty while Jenkins is green.
- The private acceptance receipt cannot be bound to the archived exact ZIP,
  or the release process would rebuild after acceptance.
- Branch protection cannot be changed without dropping an existing required
  check before its Jenkins replacement is proven.
- CodeQL SARIF upload needs a broad production token or exposes that token to
  untrusted build code.

## Maintenance

The organization folder is defined in controller JCasC, not the Jenkins UI.
Reviewers should compare the published ZIP SHA with the tested candidate and
the GitHub release asset. Keep `validate:collector-release` fail-closed: a
synthetic Chromium pass is not a live supplier receipt. Never promote a queued
or merely started Jenkins build as release evidence.
