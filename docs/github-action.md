# GitHub Action

`action.yml` is a composite action: it sets up Bun, installs loupe's deps, and
runs the reviewer against the PR. The harness CLI must be installed by the
consuming workflow (it is not bundled).

## Minimal workflow

```yaml
name: loupe
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    paths: ["**"]
permissions:
  contents: read
  pull-requests: write # required to post the review
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    continue-on-error: true # advisory: never block a PR
    steps:
      - uses: actions/checkout@v4
      - name: Install whip
        run: |
          curl -fsSL -o whip https://github.com/context-labs/whip/releases/download/v0.4.1/whip-linux-x64
          chmod +x whip && sudo mv whip /usr/local/bin/whip
      - uses: context-labs/loupe@v0
        with:
          harness: whip
          model: kimi-k3
          config: .loupe.json
        env:
          INFERENCE_API_KEY: ${{ secrets.INFERENCE_API_KEY }}
```

See `examples/review.example.yml` for whip / claude / custom-prompt
variants. The live monorepo wiring is `inference/.loupe/` + the
`inference--loupe-review.yml` workflow.

## GitHub token and thread resolution

The `github-token` input defaults to `${{ github.token }}`. This remains the
zero-configuration, backwards-compatible setup and is sufficient to read pull
requests, post inline reviews, and create or update the persistent summary.

Loupe also preserves inline discussions and resolves a thread after its finding
is addressed. GitHub may reject the GraphQL `resolveReviewThread` mutation for
the workflow's default installation token with `Resource not accessible by
integration`. Resolution is best-effort: Loupe logs a warning and leaves the
thread open; the rest of the review still succeeds.

To enable automatic resolution, pass a fine-grained PAT or GitHub App
installation token that can access the repository and has **Pull requests: read
and write**. Store it as an Actions secret and override only this input:

```yaml
- uses: context-labs/loupe@v0
  with:
    github-token: ${{ secrets.LOUPE_GITHUB_TOKEN }}
    harness: whip
    config: .loupe.json
  env:
    INFERENCE_API_KEY: ${{ secrets.INFERENCE_API_KEY }}
```

For a fine-grained PAT, restrict repository access to the repositories Loupe
reviews. Prefer a short-lived GitHub App installation token for organization-wide
use. Secrets are not normally exposed to workflows triggered by pull requests
from forks, so keep fork handling and privilege boundaries in mind.

## Chat: `@loupe` in PR comments

Add a second job triggered by comment events so people can talk to loupe:

```yaml
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
jobs:
  chat:
    if: >-
      github.event.issue.pull_request != null &&
      contains(github.event.comment.body, '@loupe')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: context-labs/loupe@v0
        with: { harness: whip, config: .loupe.json }
        env: { INFERENCE_API_KEY: ${{ secrets.INFERENCE_API_KEY }} }
```

Commands: `@loupe review` (re-review the whole PR), `@loupe fix <what>` (make the
change and push a commit to the PR branch), `@loupe <question>` (answer grounded
in the diff), `@loupe help`. loupe auto-detects the comment event and switches to
chat mode; a comment without `@loupe` is ignored.

`@loupe fix` needs the chat job to have `permissions: contents: write` (to push)
and only works on same-repo branches, not forks.

## Inputs

`harness`, `model`, `reasoning`, `profile`, `verify`, `full`, `prompt-file`,
`config`, `reviewer`, `dir`, `convention-paths`, `credential-providers`,
`github-token`. Each maps to a `LOUPE_*` env var (see below); config/prompt
paths resolve against `GITHUB_WORKSPACE` (the checkout), not the action's own
directory.

## Env vars

The entrypoint reads only these (parsed in `packages/action/src/config.ts`):
`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, `GITHUB_WORKSPACE`,
`LOUPE_PR_NUMBER`, `LOUPE_HARNESS`, `LOUPE_MODEL`, `LOUPE_REASONING`,
`LOUPE_PROMPT_FILE`, `LOUPE_CONFIG`, `LOUPE_REVIEWER`, `LOUPE_DIR`,
`LOUPE_CONVENTION_PATHS`, `LOUPE_CREDENTIAL_PROVIDERS`, `LOUPE_INFISICAL_ENV`,
`LOUPE_INFISICAL_PROJECT_ID`, `LOUPE_PROFILE`, `LOUPE_VERIFY`, `LOUPE_FULL`.
Comment/chat mode is auto-detected from `GITHUB_EVENT_NAME` (`issue_comment` /
`pull_request_review_comment`), which the runner sets.

## Private-repo action access

To use the private `context-labs/loupe` action from another org repo without
publishing it, set loupe's Actions access to the org:

```bash
gh api -X PUT repos/context-labs/loupe/actions/permissions/access \
  -f access_level=organization
```

## Recommended posture

- **Advisory:** `continue-on-error: true`, not a required check — findings are PR
  comments, never a merge gate.
- **Cadence:** `ready_for_review` + skip drafts + `concurrency: cancel-in-progress`
  so drafts are ignored and rapid pushes collapse to the latest commit.
- **Thread lifecycle:** loupe posts new findings as inline comments, keeps a
  matching unresolved thread open without duplicating it, and resolves the
  thread after the finding is addressed (when the configured token permits it).
