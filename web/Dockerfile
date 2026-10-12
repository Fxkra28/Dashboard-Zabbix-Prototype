# Explicit minor tags and digests, as in server/Dockerfile: keep the Node one the same.
FROM node:24.11-alpine@sha256:682368d8253e0c3364b803956085c456a612d738bd635926d73fa24db3ce53d7 AS build
WORKDIR /app
# Copy the lockfile too and use `npm ci`: `npm install` resolves fresh versions
# at build time, so two builds of the same commit can ship different code.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# The unprivileged build runs as uid 101, not root, and so cannot bind port 80:
# it listens on 8080 (nginx.conf). Its pid file and temp files go under /tmp.
FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Proxy settings shared by the /bff locations. Not *.conf, so nginx loads it only where included.
COPY bff-proxy.inc /etc/nginx/conf.d/bff-proxy.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
