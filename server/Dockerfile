# ---- build stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# native module fallback (better-sqlite3 prebuilds usually cover linux-x64)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci

COPY server ./server
RUN npm run build --workspace server
RUN npm prune --omit=dev

# ---- runtime stage ----------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    AB_DB_PATH=/data/agentboard.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]