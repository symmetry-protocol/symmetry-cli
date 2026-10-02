# Development and releases

The CLI requires Node.js 22.15 or newer and npm. It uses the published `@symmetry-hq/sdk@1.0.23`, pinned in `package.json` and `npm-shrinkwrap.json`. `symmetry status` reports the installed SDK version.

## Development checks

From the CLI directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run test:package
```

`npm run check` compiles TypeScript and runs the CLI tests, including input validation, exact amounts, transaction recovery, signing, JSON output and MCP stdio. Run `node dist/cli.js` to use the local build.

`npm run test:package` verifies the archive contents, installs the package in a clean environment, and checks SDK resolution, CLI commands, agent documentation and MCP resources.

## Create an installable archive

```sh
npm pack
npm install --global ./symmetry-hq-cli-0.1.0.tgz
symmetry --help
symmetry status
```

`npm pack` runs the build and tests before producing the installable archive.

The archive includes the compiled CLI, examples, documentation, license and npm shrinkwrap. Package contents are defined by the `files` list in `package.json`.

## Integration

Use [README](../README.md) for command examples and configuration, the [agent contract](AGENT.md) for automation and recovery, and [safe operation](SECURITY.md) for signing and local storage guidance.

Writes prepare plans by default. Review the plan before local execution or external signing. Inspect transaction signatures and pending intents to determine completion; confirmation of one transaction does not imply completion of a multi-step operation.
