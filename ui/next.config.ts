import type { NextConfig } from "next";
import path from "path";

// Same-origin proxy for browser gRPC-Web calls.
//
// Hardcoded — not read from `process.env` — because envoy is always
// reachable inside the docker swarm at the service-name DNS `envoy`
// on port 8811. Reading from an env var here would let a committed
// `ui/.env.local` bake a dev-local URL (`http://localhost:8811`) into
// the published image at `next build` time. Local dev bypasses this
// proxy entirely via
// `NEXT_PUBLIC_GRPC_URL` (see `ui/.env.example`), so no env-var
// escape hatch is needed.
const ARBORTER_GRPC_UPSTREAM = "http://envoy:8811";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone", // For optimized Docker builds
  // Tell Next.js where the monorepo root is for file tracing.
  // __dirname is the `ui/` app; `..` is the terminal-ui repo root that
  // contains `ui/` and `packages/sdk-typescript/`. Do not use `../..`: it
  // escapes the repo and produces a `standalone/<parent-dir>/ui/server.js`
  // layout that breaks the runtime `bun ui/server.js` in Docker.
  outputFileTracingRoot: path.join(__dirname, ".."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${ARBORTER_GRPC_UPSTREAM}/:path*`,
      },
    ];
  },
};

export default nextConfig;
