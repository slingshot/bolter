# react-devtools-core (stub)

Not the real package. See `index.js` for why this exists.

If you actually want React DevTools against the Ink dashboard, remove the
`react-devtools-core` entry from `apps/cli/package.json`, `bun add -d
react-devtools-core`, and run with `DEV=true`. Do not ship a binary built
that way: it is ~16 MB larger for a branch that cannot execute.
