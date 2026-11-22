# intendednull/paseo — downstream source fork of getpaseo/paseo

The operator's NixOS flake (~/nixos, private) builds this fork from source with upstream's own Nix files
(`nix/package.nix` for the daemon/CLI, `nix/desktop-package.nix` for the Electron
app), called with ~/nixos's nixpkgs. Runbook: docs/forks.md in ~/nixos ("Paseo").

Two commits fix upstream's Nix packaging itself (patch-package never ran; the
unpackaged Electron fetched React DevTools).

## Why this fork exists

~/nixos carried these changes as diffs against the shipped release's dist JS
(forks/paseo/patches, asar patching). Keeping them as TypeScript commits here
makes them readable, testable with upstream's suite, and rebasable.

## Notes

`.fork/notes/` keeps investigation write-ups behind carried patches (e.g. the
remote-finish analysis behind the #8575 backport, with its earlier dist-format
backport patch for reference). The backport itself was dropped at v0.17.0-beta.1
(upstream shipped #8575 in v0.16.0); the notes stay as history.

## Upstream contribution policy

Contributions upstream are OFF unless the operator asks, for that change only.

## Queue

`git log --reverse $(cat .fork/base)..nixos` — `.fork/base` names the upstream tag the
queue sits on. Every commit carries `Upstream-Status:`
(backport | submitted | closed (<reason>) | unsent | local) and `Drop-When:`.

## Drop-When at a glance

The commit trailers are authoritative; this is the summary.

| commit                                                   | drop when                                                |
| -------------------------------------------------------- | -------------------------------------------------------- |
| fix(voice): honour the requested cwd                     | upstream honours or rejects explicit cwds under voice    |
| fix(stt): reset the OpenAI STT buffer on commit          | upstream resets the buffer before awaiting               |
| fix(voice): keep a pending turn                          | upstream stops dropping in-flight turns on speech start  |
| fix(voice): interrupt only once the transcript has words | upstream gates barge-in on words                         |
| feat(app): "Recent activity" sidebar sort                | upstream ships an activity sort                          |
| fix(desktop): React DevTools only when asked             | upstream's Nix desktop runs packaged, or gates DevTools  |
| fix(nix): apply the patch-package backports              | upstream's Nix packages apply patches/                   |
| feat(app): "Date" sidebar grouping                       | upstream ships a date or ungrouped sidebar mode          |
| fix(nix): refresh npm-deps.hash for <tag>                | the tag's npm-deps.hash matches its package-lock.json    |
| feat(server): add compact_agent MCP tool                 | upstream ships a remote compaction MCP tool (#8708)      |
| feat(server): auto-compact idle agents before cache TTL  | upstream ships per-provider idle auto-compaction         |
| fix(server): forward supportsCompaction in wrapper       | upstream forwards supportsCompaction in provider wrap    |
| fix(server): harden ACP safety and compaction plumbing   | upstream forwards compaction flags and ACP safety checks |
| feat(server): support compact_agent for Codex & OpenCode | upstream ships multi-provider compact_agent (#8708)      |

## Branches

- `nixos`: base tag plus the patch queue; what the flake builds.
- `patch/<slug>`: one change, cut from `nixos`.
- `pin/<date>-<short8>` tags: every pinned rev. Never moved or deleted.

## Remotes

`origin` is intendednull/paseo; `upstream`'s push URL is `no_push`, which guards
only `git push`. `gh repo set-default intendednull/paseo` keeps `gh` off the upstream.

## Updating to a new upstream tag

Upstream tags each sit on their own release branch: the old tag is usually not an
ancestor of the new one. Replaying `<old-tag>..nixos` still works.

1. `git fetch upstream --tags`. This clone is `blob:none`: check the new tag out in a
   scratch worktree (`git worktree add --detach /tmp/paseo-<tag> <tag>`) before grepping
   it, or `git grep <tag>` fetches blobs one at a time.
2. Check every commit's `Drop-When:` against the release notes and the new tag's source.
3. In that worktree, `git switch -c bump/<tag>` and cherry-pick the kept commits
   (`git log --reverse --format=%h $(cat .fork/base)..nixos`). `nixos` stays on the
   current pin until the gate passes.
4. Write the tag into `.fork/base`, drop the dropped commits' paths from `.fork/gate`,
   and update the table above.
5. `npm ci --ignore-scripts`, `node scripts/postinstall-patches.mjs`, then `.fork/gate`.
6. Check `nix/npm-deps.hash`: upstream's hash bot runs on main, not on `release/*`,
   so a release commit that touches `package-lock.json` after the bot's last commit
   leaves it stale (v0.17.0-beta.1). Compare
   `git log -1 --format=%ci <tag> -- nix/npm-deps.hash` with the same for
   `package-lock.json`. If the hash is older, or the queue changes the lock, refresh
   it (the npm-deps FOD's "got" hash, or `scripts/update-nix.sh`) in a
   `fix(nix): refresh npm-deps.hash` commit.
7. Move `nixos` to the branch, tag `pin/<date>-<short8>`, push `nixos` with
   `--force-with-lease=nixos:<old pin sha>` and the tag.
8. In a ~/nixos worktree: set the `paseo-src` rev, `nix flake lock --update-input paseo-src`,
   then `nix build .#paseo-src .#paseo-src-desktop` and the forks/paseo/test checks.
