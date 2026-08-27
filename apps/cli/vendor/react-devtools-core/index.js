/**
 * A stub standing in for the real `react-devtools-core` (16 MB).
 *
 * Ink's reconciler imports this package behind `process.env.DEV === 'true'`,
 * which is never true in a shipped binary — but the import is part of the
 * module graph, so `bun build --compile` must resolve it or the build fails.
 * `--external` does not help: a compiled binary then tries to resolve it at
 * runtime, from inside /$bunfs, and dies on the first render.
 *
 * A `file:` devDependency is what creates the node. `overrides` cannot:
 * it replaces an existing resolution, and react-devtools-core is an optional
 * peer nothing installs, so there is nothing there to replace.
 */
export default {
    initialize() {
        // Intentionally nothing: the real package is not shipped.
    },
    connectToDevTools() {
        // Intentionally nothing: the real package is not shipped.
    },
};
