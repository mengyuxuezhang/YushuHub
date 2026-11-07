# syntax=docker/dockerfile:1
# Context MUST be an audited official ZIP extracted by prepare-context.mjs.
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/mengyuxuezhang/YushuHub" \
      org.opencontainers.image.revision="$SOURCE_REVISION"
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node . ./
RUN mkdir -p data logs && chown node:node data logs
ENV NODE_ENV=production AI_ADMIN_DEPLOYMENT_MODE=docker
USER node
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.AI_ADMIN_PORT||7077)+'/api/runtime-info',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(r=>{if(!r.success||!r.data?.version)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "cloud/ai-admin/server.mjs"]
