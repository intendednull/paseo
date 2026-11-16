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
backport patch for reference).

## Upstream contribution policy

Contributions upstream are OFF unless the operator asks, for that change only.

## Queue

`git log --reverse v0.15.4..nixos` — every commit carries `Upstream-Status:`
(backport | submitted | closed (<reason>) | unsent | local) and `Drop-When:`.

## Drop-When at a glance

The commit trailers are authoritative; this is the summary.

| commit                                                   | drop when                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| fix(voice): honour the requested cwd                     | upstream honours or rejects explicit cwds under voice             |
| fix(stt): reset the OpenAI STT buffer on commit          | upstream resets the buffer before awaiting                        |
| fix(voice): keep a pending turn                          | upstream stops dropping in-flight turns on speech start           |
| fix(voice): interrupt only once the transcript has words | upstream gates barge-in on words                                  |
| feat(claude): per-session ultracode toggle               | upstream ships ultracode independent of the thinking level        |
| feat(app): ultracode toggle on/off colour                | the toggle is dropped, or upstream colours unknown active toggles |
| feat(app): "Recent activity" sidebar sort                | upstream ships an activity sort                                   |
| fix(server): #8575 backport                              | rebased onto >= v0.16.0                                           |
| fix(desktop): React DevTools only when asked             | upstream's Nix desktop runs packaged, or gates DevTools           |
| fix(nix): apply the patch-package backports              | upstream's Nix packages apply patches/                            |
| feat(app): "Date" sidebar grouping                       | upstream ships a date or ungrouped sidebar mode                   |

## Branches

- `nixos`: base tag plus the patch queue; what the flake builds.
- `patch/<slug>`: one change, cut from `nixos`.
- `pin/<date>-<short8>` tags: every pinned rev. Never moved or deleted.

## Remotes

`origin` is intendednull/paseo; `upstream`'s push URL is `no_push`, which guards
only `git push`. `gh repo set-default intendednull/paseo` keeps `gh` off the upstream.

## Updating to a new upstream tag

1. `git fetch upstream --tags`, then `git rebase --onto <new-tag> <old-tag> nixos`;
   drop any commit whose `Drop-When:` has happened (e.g. the #8575 backport at >= v0.16.0).
2. `.fork/gate`.
3. Only if the queue changes `package-lock.json`: `scripts/update-nix.sh` (upstream's
   release commits keep `nix/npm-deps.hash` current otherwise).
4. In a ~/nixos worktree: `nix flake lock --update-input paseo-src`, then
   `nix build .#paseo-src .#paseo-src-desktop` and the forks/paseo/test checks.
