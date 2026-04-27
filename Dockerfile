# Stage 1: Builder
FROM oven/bun:1@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS builder

WORKDIR /app

# Native-module build deps for optional transitive deps (utf-8-validate, bufferutil)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace root package files first
COPY package.json bun.lockb* ./

# Copy workspace member package files
COPY ui/package.json ./ui/
COPY packages/sdk-typescript/package.json ./packages/sdk-typescript/

# Install dependencies (workspace aware)
RUN bun install --frozen-lockfile

# Copy SDK source
COPY packages/sdk-typescript ./packages/sdk-typescript

# Build the SDK first (generates types and compiles)
RUN cd packages/sdk-typescript && bun run build

# Copy ui source
COPY ui ./ui

# Set working directory to ui app
WORKDIR /app/ui

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_ORGANIZATION_ID
ARG NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID

# Set environment variables for Next.js build
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_ORGANIZATION_ID=$NEXT_PUBLIC_ORGANIZATION_ID
ENV NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID=$NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID

ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:1-slim@sha256:7e8ed3961db1cdedf17d516dda87948cfedbd294f53bf16462e5b57ed3fff0f1

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/ui/.next/standalone ./
COPY --from=builder /app/ui/.next/static ./ui/.next/static
COPY --from=builder /app/ui/public ./ui/public

ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "ui/server.js"]
