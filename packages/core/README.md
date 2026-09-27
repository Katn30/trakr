# @chronicle/core

The shared core of [`@chronicle/unit-of-work`](https://github.com/Katn30/chronicle/tree/main/packages/unit-of-work) and
[`@chronicle/event-log`](https://github.com/Katn30/chronicle/tree/main/packages/event-log): models, tracked properties and
collections, validation, undo/redo and the history.

**Applications don't use this package directly.** Install one of the two
flavours: each one depends on this package and re-exports its public API, so
everything is imported from the flavour.

```bash
npm install @chronicle/unit-of-work     # or: npm install @chronicle/event-log
```

The concepts it provides (models, `construct()` / `new()`, `@Tracked`,
validation, hooks and events, collections, containers, undo/redo and the history,
saving, identity) are described in the [main README](https://github.com/Katn30/chronicle#concepts-shared-by-both-flavours).

Exports marked `@internal` are shared with the two flavours and are not part of
the public API: they may change in any release.

## License

MIT
