const logger = require('./logger');

/**
 * Audit log — records security-relevant actions for compliance and debugging.
 * In production, these should be persisted to a dedicated audit log store.
 * For now, we log them at 'info' level with structured metadata.
 */
function audit(action, details = {}) {
  logger.info(`AUDIT: ${action}`, {
    action,
    ...details,
    timestamp: new Date().toISOString(),
  });
}

module.exports = audit;