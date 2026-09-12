FROM node:22.22.0-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.web.json vite.config.ts ./
COPY web ./web
COPY shared ./shared
COPY docs ./docs
COPY public ./public
COPY standalone/server.ts ./standalone/server.ts
RUN npm run build:standalone

FROM node:22.22.0-alpine
ENV HOST=0.0.0.0 PORT=8080 \
    SHELL_ONLINE_WEB_ROOT=/app/web \
    SHELL_ONLINE_STATE_FILE=/var/lib/shell-online/relay.json
WORKDIR /app
RUN addgroup -S shellonline && adduser -S -G shellonline shellonline \
    && install -d -o shellonline -g shellonline /var/lib/shell-online
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=shellonline:shellonline /src/dist /app/web
COPY --from=build --chown=shellonline:shellonline /src/standalone/dist/server.mjs /app/server.mjs
USER shellonline
EXPOSE 8080
VOLUME ["/var/lib/shell-online"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
