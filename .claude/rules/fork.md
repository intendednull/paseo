# Agent rules for the Paseo downstream fork

- Upstream contributions are OFF. Never draft or file issues, PRs, comments or
  reviews on getpaseo/paseo unless the operator asks for that specific change.
- Pushing to intendednull/paseo is pre-authorised: `patch/*` branches, `nixos`
  (including the guarded force-push after a rebase) and `pin/*` tags. Never push to an
  upstream.
- Work on `patch/<slug>` cut from `nixos`, following upstream's CLAUDE.md and
  docs/coding-standards.md, with `Upstream-Status:`/`Drop-When:` trailers.
- Run `.fork/gate` before landing anything.
