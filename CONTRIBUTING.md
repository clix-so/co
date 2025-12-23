# How to become a contributor and submit your own code

## Table of contents

- [Contributing a patch](#contributing-a-patch)
- [Running the tests](#running-the-tests)
- [Code style](#code-style)

## Contributing a patch

1. Submit an issue describing your proposed change to the repo in question.
2. The repo owner will respond to your issue promptly.
3. Fork the desired repo, develop and test your code changes.
4. Ensure that your code adheres to the existing style in the code to which you are contributing.
5. Ensure that your code has an appropriate set of tests which all pass.
6. Title your pull request following [Conventional Commits](https://www.conventionalcommits.org/) styling.
7. Submit a pull request.

## Running the tests

### Before you begin

1. [Install Bun](https://bun.sh/)

### Install dependencies

```bash
bun install
```

### Run the tests

```bash
bun test
```

### Run type checking

```bash
bun run typecheck
```

### Lint and format

```bash
bun run lint
bun run lint:fix
bun run format
```

## Code style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Please ensure your code passes all lint checks before submitting a pull request.

### Conventions

- Use `camelCase` for variables and functions
- Use `PascalCase` for classes and types
- Do not use `_` prefix for private fields
- Do not use `Impl` suffix for class names
- Prefer `for...of` loops over `forEach` when the callback has side effects
