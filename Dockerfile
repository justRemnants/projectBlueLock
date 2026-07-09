# Upgrade to Node.js 22 LTS to enable out-of-the-box native WebSocket support
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy the entire monorepo code into the container
COPY . .

# Install dependencies for the bot workspace (the daemon engine)
RUN cd bot && npm install

# Install dependencies for the web workspace (required by imported panels and database modules)
RUN cd web && npm install

# Set runtime configuration environment
ENV NODE_ENV=production

# Start the persistent gateway bot client daemon
CMD ["node", "bot/index.js"]