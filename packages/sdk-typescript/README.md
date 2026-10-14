# @aspensprotocol/sdk-ts

TypeScript gRPC-Web client for the Aspens arborter: market config, order encoding and signing
(EIP-191 / Ed25519), order submission and cancellation, orderbook and trade polling, balances,
settlement-address resolution, Solana instructions, and decimals handling. No React dependency.

The generated protobuf types under `src/protos/` arrive from the `protos` repo's `sync-protos`
fan-out; do not edit them by hand.

## Installing

The package is published to GitHub Packages, which requires authentication even to read. In
the consuming project, add an `.npmrc`:

```ini
@aspensprotocol:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` is a personal access token (classic) with `read:packages` locally. In GitHub
Actions, use the workflow's `secrets.GITHUB_TOKEN` with `permissions: packages: read`; a
repository other than `aspensprotocol/terminal-ui` also needs read access granted under the
package's settings ("Manage Actions access").

```bash
bun add @aspensprotocol/sdk-ts
```

The build emits ES modules with extensionless relative imports in places, so consume it
through a bundler (Next.js, Vite, …) rather than plain Node ESM.

## Releasing

1. Bump `version` in `package.json` and merge to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag sdk-v0.2.0 && git push origin sdk-v0.2.0
   ```

`.github/workflows/publish-sdk.yml` checks that the tag matches `package.json`, runs the tests,
builds, and publishes. A version can be published only once.
