# Reproducible build, and not deprecated: Railway's Config as Code (railway.json)
# is being retired, and services that never used it cannot opt in. A Dockerfile
# pins the build the same way and works on any host that runs containers.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci --include=optional

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only. `--include=optional` keeps the AWS SDK, which
# the SES provider and control plane import lazily at runtime.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --include=optional && npm cache clean --force

COPY --from=build /app/dist/src ./dist/src
COPY migrations ./migrations

# The image listens on $PORT, which the platform injects; 8080 is the default.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/src/cli.js", "serve"]
