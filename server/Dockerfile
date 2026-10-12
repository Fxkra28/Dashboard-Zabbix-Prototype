# An explicit minor tag and the digest it pointed at on 12 October 2026, so a rebuild never
# moves to different bytes unannounced. Docker builds from the digest; the tag is for the
# reader. Dependabot (.github/dependabot.yml) proposes the new pair when a release comes. Raise
# it on purpose, in both FROM lines and in web/Dockerfile.
FROM node:24.11-alpine@sha256:682368d8253e0c3364b803956085c456a612d738bd635926d73fa24db3ce53d7 AS build
WORKDIR /app
# `npm ci` against the committed lockfile, so the image is reproducible: plain
# `npm install` re-resolves versions and two builds of one commit can differ.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.11-alpine@sha256:682368d8253e0c3364b803956085c456a612d738bd635926d73fa24db3ce53d7
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Which build is running, shown by /api/health; compose's build.args fill them.
# After the npm layers, so a new commit does not redo `npm ci`.
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV BUILD_COMMIT=$BUILD_COMMIT BUILD_TIME=$BUILD_TIME
# The image's own unprivileged user, not root: this process holds both Zabbix tokens
# and the AI key. It writes no files, so the root-owned app needs no chown.
USER node
EXPOSE 4000
# Exec form, no `npm start` and no shell: SIGTERM reaches node (as PID 1, or from
# compose's init) and index.ts closes on it. A shell or npm in front would swallow it.
CMD ["node", "dist/index.js"]
