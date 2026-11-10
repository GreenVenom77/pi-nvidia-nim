# Releasing

1. Add a `## <new version>` section to `CHANGELOG.md` (the release notes are taken from it verbatim).
2. Commit it, then run `npm run release -- <version>` (e.g. `0.9.1`; `0.10.0-rc.1` makes a pre-release).
   It refuses to continue unless the tree is clean, the tag is new, the changelog section exists and `npm test` passes;
   then it bumps `package.json`, commits and creates tag `v<version>`.
3. `git push --follow-tags`.

Pushing the tag runs `.github/workflows/release.yml`, which re-runs the tests, checks that the tag equals the
`package.json` version and that the changelog has notes for it, builds the package, and creates a GitHub release
with the notes and two attachments: `pi-nvidia-nim-<version>.tgz` (npm package) and `.zip`.

Optional: add an `NPM_TOKEN` repository secret and the same workflow also runs `npm publish`
(pre-releases go to the `next` tag). Without the secret that step is skipped.

CI (`.github/workflows/ci.yml`) runs the tests on every push to `main` and every pull request.
