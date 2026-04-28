FROM node:20

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    openjdk-17-jdk \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN mkdir -p slides temp uploads

RUN useradd -m -u 1001 appuser \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 10000

CMD ["node", "server.js"]
