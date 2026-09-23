# The Wire — single container: backend API + frontend static site, all on one port.
FROM node:22-alpine
ENV NODE_ENV=production

WORKDIR /app

# Install backend deps first (better layer caching).
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy the whole repo (frontend is served by the backend as static files).
COPY . .

WORKDIR /app/backend
EXPOSE 4000
CMD ["node", "server.js"]