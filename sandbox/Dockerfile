# Il "mini PC" di ogni bot
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl wget ca-certificates git python3 python3-pip python3-venv \
      nano jq unzip zip procps iputils-ping less file \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /root
CMD ["sleep", "infinity"]
