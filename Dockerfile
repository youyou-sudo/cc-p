# Build stage: compile single-file server binary with Bun
FROM oven/bun:1.4.2-slim AS build

WORKDIR /app

# Cache packages
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY src ./src

ENV NODE_ENV=production

# Compile the Elysia app into a single executable. Flags mirror the Release
# workflow build (release.yml) — production + minify. import.meta.dir points to
# the virtual $bunfs inside the binary, so runtime files (.env / config.json)
# must be resolved from process.cwd() — see src/config.ts (candidateDirs).
RUN bun build ./src/index.ts --compile --production --minify --outfile server

# Production stage: distroless runtime (no shell / no package manager)
FROM gcr.io/distroless/base

WORKDIR /app

# Single binary
COPY --from=build /app/server /app/server

# Runtime config. .env / config.json are optional (all settings can come from
# environment variables); when present they are read from cwd (/app).
COPY config.json /app/config.json

# Environment variables
ENV NODE_ENV=production

# Healthcheck: runs the bundled healthcheck CLI (GET /health, expects {ok:true})
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/app/server", "healthcheck"]

# Default command
CMD ["/app/server"]

EXPOSE 3050
