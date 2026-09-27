# Changesets

Every change that should appear in a release gets a changeset: run `npm run changeset`, pick the packages it affects and the kind of bump, and describe the change. The file it writes goes into the pull request with the code.

The three packages are released together (`fixed` in `config.json`): a release bumps `@chronicle/core`, `@chronicle/unit-of-work` and `@chronicle/event-log` to the same version.

To release: `npm run version-packages` (applies the changesets: versions, peer ranges, changelogs), review, commit, then `npm run release` (build, test, publish).
