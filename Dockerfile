# Build marker: v3
# Tisa ERP — single image: API + built web dashboard (the mobile app is built separately with EAS).
FROM node:22-bookworm-slim AS web
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund || (echo 'npm ci failed - falling back to npm install' && npm install --no-audit --no-fund)
COPY apps/web ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci --no-audit --no-fund || (echo 'npm ci failed - falling back to npm install' && npm install --no-audit --no-fund)
COPY apps/api ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# fonts are needed to burn the geo-stamp text into site photos
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=api /app/apps/api/package.json ./
COPY --from=api /app/apps/api/node_modules ./node_modules
COPY --from=api /app/apps/api/dist ./dist
COPY --from=api /app/apps/api/drizzle ./drizzle
COPY --from=api /app/apps/api/assets ./assets
COPY --from=web /app/apps/web/dist /app/apps/web/dist
COPY apps/api/start.sh ./start.sh
RUN mkdir -p uploads && chmod +x start.sh
EXPOSE 4000
CMD ["./start.sh"]
