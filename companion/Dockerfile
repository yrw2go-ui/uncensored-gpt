# AI Companion: no npm install needed (zero dependencies).
FROM node:22-alpine
WORKDIR /app
COPY . .
# Characters, profiles and memories live here. Mount a persistent volume at /data.
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
