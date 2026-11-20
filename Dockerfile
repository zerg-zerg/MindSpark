# Zero-dependency app - just needs a Node 22+ runtime.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js uploads.js ./
COPY public ./public
ENV PORT=3000 DB_PATH=/app/data/mindspark.db

# Run as the unprivileged `node` user that this image already provides,
# rather than root. The data directory is created and chowned here, while
# we are still root - a non-root process cannot create it later, and Docker
# seeds a fresh named volume from the image's own contents and ownership,
# so doing it before VOLUME is what makes the mount writable.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
