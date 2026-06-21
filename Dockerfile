# OpenBook container image for Fly.io (and any container host).
# node:sqlite is built into Node 24, and every dependency is pure JS, so there is
# no native build step and the small Alpine image works fine.
FROM node:24-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY . .

# The database and uploads live on the mounted volume (set via DATA_DIR).
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
