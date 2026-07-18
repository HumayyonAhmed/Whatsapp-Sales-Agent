FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config
COPY public ./public

# Persisted session/lead data — mount a volume here in production so leads
# survive redeploys/restarts (see docker-compose.yml).
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
