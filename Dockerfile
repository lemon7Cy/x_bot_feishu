FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3

COPY src ./src
COPY web ./web
COPY config.example.json ./config.example.json
COPY README.md ./README.md

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["npm", "run", "web:scheduler"]
