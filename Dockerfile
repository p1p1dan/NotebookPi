# --- Build stage: compile native deps + build frontend ----------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# Install ALL deps (including devDependencies) so vite + tailwind can build the frontend.
RUN npm install --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY vite.config.js tsconfig.json ./
RUN npm run build
# Drop dev deps for the runtime image.
RUN npm prune --omit=dev

# --- Runtime stage -----------------------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY package.json ./
COPY src ./src
# Pre-create the data directory so the SQLite file has somewhere to land even if
# no host volume is bind-mounted. (Single-user app: container runs as root for
# bind-mount simplicity — no privileged ports, no inbound network from data,
# and container isolation is the real security boundary anyway.)
RUN mkdir -p /app/data
EXPOSE 8454
CMD ["node", "src/server.js"]
