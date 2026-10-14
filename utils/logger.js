const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format — structured JSON in production, readable in dev
const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const log = {
    level,
    message,
    timestamp,
    ...(stack && { stack }),
    ...meta,
  };
  return JSON.stringify(log);
});

const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  return `${timestamp} [${level}]: ${stack || message} ${metaStr}`;
});

const isProduction = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: combine(
    timestamp(),
    errors({ stack: true }),
    isProduction ? logFormat : combine(colorize(), devFormat)
  ),
  defaultMeta: { service: 'event-tracking-backend' },
  transports: [
    new winston.transports.Console(),
  ],
});

// In production, also log to a file for debugging
if (isProduction) {
  logger.add(new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 5,
  }));
  logger.add(new winston.transports.File({
    filename: 'logs/combined.log',
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  }));
}

module.exports = logger;