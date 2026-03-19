const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// BullMQ setup (optional - for job queue)
let researchQueue = null;
try {
  if (!process.env.REDIS_URL) {
    console.log('[Server] REDIS_URL not set; BullMQ disabled');
  } else {
    const { Queue } = require('bullmq');
    const IORedis = require('ioredis');

    const connection = new IORedis(process.env.REDIS_URL, {
      // Don't spam retries if Redis isn't running locally.
      retryStrategy: () => null,
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    let loggedRedisError = false;
    connection.on('error', (err) => {
      if (loggedRedisError) return;
      loggedRedisError = true;
      console.warn(
        `[Server] Redis not reachable (${process.env.REDIS_URL}); BullMQ disabled. ` +
          `Start Redis (or set REDIS_URL) to enable queues.`
      );
      console.warn(err?.message || err);
      try {
        connection.disconnect();
      } catch (_) {}
      researchQueue = null;
    });

    // Trigger a single connection attempt (lazyConnect + no retry).
    // Only create the Queue if Redis is actually reachable; otherwise BullMQ will keep emitting errors.
    connection
      .connect()
      .then(() => {
        researchQueue = new Queue('research', { connection });
        console.log('[Server] BullMQ initialized');
      })
      .catch(() => {
        // handled by the connection 'error' listener (single warning)
      });
  }
} catch (err) {
  console.log('[Server] BullMQ not available, using direct execution');
}

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/research', require('./routes/research'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/autopilot', require('./routes/autopilot'));
app.use('/api/dld', require('./routes/dld'));
app.use('/api/market', require('./routes/market'));
app.use('/api/team', require('./routes/team'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/notifications', require('./routes/notifications'));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const server = app.listen(PORT, HOST, () => {
  console.log(`IERE Backend Server running on ${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Start autopilot worker (if not in test mode)
if (process.env.NODE_ENV !== 'test') {
  const { startAutopilotWorker } = require('./workers/autopilotWorker');
  startAutopilotWorker();
}

module.exports = { app, researchQueue };
