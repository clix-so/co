# Changelog

[npm history][1]

[1]: https://www.npmjs.com/package/@clix-so/co?activeTab=versions

## [0.1.0](https://github.com/clix-so/co/releases/tag/v0.1.0) (2024-12-23)

### Features

- Initial release
- Go-style `co()` execution API for Bun Workers
- Context system with cancellation and timeout support (`context.withCancel`, `context.withTimeout`, `context.withDeadline`)
- Context values propagation (`context.withValue`)
- Worker pool management (`co.pool.configure`, `co.pool.shutdown`, `co.pool.stats`)
- Custom error types (`CancelledError`, `DeadlineExceededError`, `TimeoutError`, `QueueFullError`, `ShutdownError`)
