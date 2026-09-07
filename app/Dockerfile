# The client and the service ship together in one image, because they have to
# share an origin: the relay refuses a websocket whose Origin is not its own,
# and the browser sets that from wherever the page was served. Splitting them
# across two hostnames would leave every terminal unable to connect.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# VITE_ variables are read at build time and baked into the client bundle, so
# they arrive as build arguments rather than as container environment.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_ACCOUNTS_URL=""
ARG VITE_RELAY_URL
RUN npm run build

# Reinstall without the build toolchain, so nothing that compiled the app is
# left in the image that runs it.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node:alpine ships a "node" user; the app never needs to write to its own
# files, so it runs as that user against a read-only-friendly layout.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
ENV CLIENT_DIR=/app/dist
ENV PORT=8080
EXPOSE 8080

# Liveness only: it answers without touching the database, so a busy or
# restarting Postgres does not get this container killed and restarted too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]
