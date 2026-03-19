FROM node:20-alpine

WORKDIR /app
ENV PORT=8080

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Expose Railway-compatible port
EXPOSE 8080

# Start server
CMD ["node", "server.js"]
