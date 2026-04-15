# Stage 1: Builder
FROM oven/bun:1@sha256:8956c7667fa17beb6e3c664115e66bdacfe502da5d99603626e74c197bdef160 AS builder

WORKDIR /app

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
FROM oven/bun:1-slim@sha256:d3c7094c144dd3975d183a4dbc4ec0a764223995bff73290d983edb47043a75f

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/ui/.next/standalone ./
COPY --from=builder /app/ui/.next/static ./app/ui/.next/static
COPY --from=builder /app/ui/public ./app/ui/public

ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "ui/server.js"]
