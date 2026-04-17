import type { NextConfig } from "next";
import path from "path";

// Server-side only — read at request time, NOT baked into the bundle
// like NEXT_PUBLIC_*. Every /api/* call the client makes is proxied to
// this target by Next.js before the browser sees a response, so the
// same built image works in any environment (local docker swarm
// reaches `envoy:8811` on the internal overlay; cloud stacks likewise
// reach envoy by its service name, no public route required).
const arborterGrpcUrl = process.env.ARBORTER_GRPC_URL ?? "http://envoy:8811";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone", // For optimized Docker builds
  // Tell Next.js where the monorepo root is for file tracing
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${arborterGrpcUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
