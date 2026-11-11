# offhub

Archive a GitHub repository's issues, pull requests, discussions and releases
as a searchable website that works offline. One repository, several, or every
repository of a user or organization.

`git clone` saves your code. It does not save the years of bug reports, design
decisions and review comments around it. offhub does: one command, one folder,
open `index.html`.

```bash
node bin/offhub.js cli/cli
```

## What you get

```
cli-archive/
  index.html        searchable list of everything (filter by kind, state, text)
  issues/123.html   one plain HTML page per issue
  pulls/456.html    pull requests with reviews and inline review comments
  discussions/7.html  discussions with replies and the accepted answer
  releases/         release notes with links to the release files
  assets/           images from the threads, stored locally
  data/             the same content as JSON, one file per item
  code.git/         a git mirror of the repository
  wiki.git/         a git mirror of the wiki, if there is one
```

- **Readable.** Pages are plain HTML with GitHub's own rendering of the
  Markdown. No server and no database, any browser opens them from disk.
- **Incremental.** Run it again on the same folder and it fetches only what
  changed since the last run.
- **No dependencies.** Node.js 20 or newer is all it needs.
- **Works for private repositories**, with any token that can read them.

## Usage

Not on npm yet. Clone this repository and run it with Node:

```bash
git clone https://github.com/w2ckwj45hv-source/offhub
cd offhub
node bin/offhub.js <owner>/<repo> [options]          # one repository
node bin/offhub.js <owner> [options]                 # everything a user or organization owns, forks left out
node bin/offhub.js <a>/<b> <c>/<d> [options]         # several at once
```

With more than one repository, the output folder holds one archive per
repository as `<owner>/<repo>/` and a start page that lists them. A repository
that fails is reported and the others still run.

| Option | Meaning |
| --- | --- |
| `-o, --out <dir>` | Output folder. Default: `./<repo>-archive`, or `./github-archive` for several repositories |
| `--limit <n>` | Only the `n` most recently updated items per kind. Good for a quick look at a big project. |
| `--no-images` | Do not download images |
| `--no-git` | Do not mirror the code and wiki |
| `--rebuild` | Re-render all pages from `data/` without touching the network |

A GitHub token is required, because discussions are only available through the
GraphQL API. offhub reads it from `GITHUB_TOKEN`, then `GH_TOKEN`, then
`gh auth token`. If you use the GitHub CLI and are logged in, there is nothing
to set up.

## Scheduled backup with GitHub Actions

```yaml
name: archive
on:
  schedule: [{ cron: '0 3 * * 0' }]
  workflow_dispatch:
jobs:
  archive:
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: read, pull-requests: read, discussions: read }
    steps:
      - uses: w2ckwj45hv-source/offhub@v0.2.0
      - uses: actions/upload-artifact@v4
        with: { name: archive, path: archive }
```

| Input | Default | Meaning |
| --- | --- | --- |
| `repository` | the current repository | One or more `<owner>/<repo>` names or an `<owner>`, separated by spaces |
| `token` | the workflow token | Use a personal token to archive other private repositories |
| `out` | `archive` | Output folder |
| `args` | | Extra flags, for example `--no-git --limit 100` |

## Limits

- Very long pull request reviews are cut off: at most 50 reviews per pull
  request, 30 inline comments per review and 50 replies per discussion comment
  are archived. Affected pages say so and link to the original.
- Projects, reactions and commit comments are not archived.
- Videos, file attachments and release files stay as links to GitHub. Only
  images are stored.
- Releases are fetched in full on every run, the other kinds incrementally.
- Items deleted on GitHub stay in the archive.
- An interrupted first run starts over for the kind it was working on.

## Security notes

- The token is sent only to `api.github.com` and, for the git mirror, to
  `github.com`. It is never written to disk.
- Images are downloaded only from `github.com` and `*.githubusercontent.com`.
  Image links to other hosts are left untouched and never requested.
- Issue and comment bodies are GitHub's sanitized HTML. Everything else on a
  page (titles, user names, labels) is escaped.

## Development

```bash
npm test
```

## License

MIT
