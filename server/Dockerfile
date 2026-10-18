# Il visore dello schermo (noVNC) viene preso dall'immagine del mini PC: va costruita prima (lo fa install.sh)
ARG SANDBOX_IMAGE=botlab-sandbox
FROM ${SANDBOX_IMAGE} AS sandbox
FROM docker:cli AS dockercli

FROM node:22-alpine
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=sandbox /usr/share/novnc /app/novnc
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
