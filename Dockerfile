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

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3001; const req = require('http').get('http://127.0.0.1:' + port + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)); req.on('error', () => process.exit(1));"

# Start server
CMD ["node", "server.js"]
