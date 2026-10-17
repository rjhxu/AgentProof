# Browser runner image. Playwright's base image ships Chromium + system deps.
# Build from the repo root:  docker build -f apps/runner/Dockerfile -t agentproof-runner .
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/runner/package.json apps/runner/
COPY packages/shared/package.json packages/shared/
COPY packages/agent/package.json packages/agent/
COPY packages/verifier/package.json packages/verifier/
COPY packages/diagnostics/package.json packages/diagnostics/
RUN pnpm install --frozen-lockfile --filter @agentproof/runner...

COPY apps/runner apps/runner
COPY packages packages

ENV RUNNER_PORT=4000
EXPOSE 4000
CMD ["pnpm", "--filter", "@agentproof/runner", "start"]
