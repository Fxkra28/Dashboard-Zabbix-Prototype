FROM node:20-alpine AS build
WORKDIR /app
# `npm ci` against the committed lockfile, so the image is reproducible: plain
# `npm install` re-resolves versions and two builds of one commit can differ.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
