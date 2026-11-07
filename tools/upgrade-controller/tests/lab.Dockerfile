# Test host only: Docker socket is exposed to this isolated controller harness,
# never to the nonroot business image. No customer configuration is copied here.
FROM docker:28-cli AS cli
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
RUN apt-get update && apt-get install -y --no-install-recommends python3 default-mysql-client procps iproute2 \
    && rm -rf /var/lib/apt/lists/* && npm install -g pm2@6.0.14 --no-audit --no-fund
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /controller
CMD ["sleep", "infinity"]
