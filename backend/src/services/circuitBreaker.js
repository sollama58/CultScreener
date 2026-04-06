/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures by stopping requests to failing services
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service has recovered
 */

const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker {
  /**
   * Create a circuit breaker
   * @param {Object} options Configuration options
   * @param {string} options.name Name of the service (for logging)
   * @param {number} options.failureThreshold Number of failures before opening circuit (default: 5)
   * @param {number} options.resetTimeout Time in ms before attempting recovery (default: 30000)
   * @param {number} options.halfOpenMaxAttempts Max requests in half-open state (default: 3)
   * @param {Function} options.isFailure Function to determine if error is a failure (default: all errors)
   */
  constructor(options = {}) {
    this.name = options.name || 'unknown';
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts || 5;
    this.isFailure = options.isFailure || (() => true);

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;

    // Metrics
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      lastStateChange: Date.now()
    };
  }

  /**
   * Execute a function with circuit breaker protection
   * @param {Function} fn Async function to execute
   * @returns {Promise<any>} Result of the function
   * @throws {Error} If circuit is open or function fails
   */
  async execute(fn) {
    this.metrics.totalRequests++;

    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === STATES.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.transitionTo(STATES.HALF_OPEN);
      } else {
        this.metrics.rejectedRequests++;
        throw new CircuitBreakerError(
          `Circuit breaker OPEN for ${this.name} - service unavailable`,
          this.name,
          this.state,
          this.getTimeUntilRetry()
        );
      }
    }

    // In HALF_OPEN, limit concurrent attempts
    if (this.state === STATES.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
      this.metrics.rejectedRequests++;
      throw new CircuitBreakerError(
        `Circuit breaker HALF_OPEN for ${this.name} - waiting for test requests`,
        this.name,
        this.state,
        this.getTimeUntilRetry()
      );
    }

    if (this.state === STATES.HALF_OPEN) {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      // Check if this error should count as a failure
      if (this.isFailure(error)) {
        this.onFailure(error);
      }
      throw error;
    }
  }

  /**
   * Record a successful request
   */
  onSuccess() {
    this.metrics.successfulRequests++;
    this.failureCount = 0;

    if (this.state === STATES.HALF_OPEN) {
      this.successCount++;
      // After 3 successful requests in HALF_OPEN, close the circuit
      if (this.successCount >= 3) {
        this.transitionTo(STATES.CLOSED);
      }
    }
  }

  /**
   * Record a failed request
   * @param {Error} error The error that occurred
   */
  onFailure(error) {
    this.metrics.failedRequests++;
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === STATES.HALF_OPEN) {
      // Any failure in HALF_OPEN reopens the circuit
      this.transitionTo(STATES.OPEN);
    } else if (this.state === STATES.CLOSED && this.failureCount >= this.failureThreshold) {
      this.transitionTo(STATES.OPEN);
    }
  }

  /**
   * Transition to a new state
   * @param {string} newState The state to transition to
   */
  transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    this.metrics.lastStateChange = Date.now();

    if (newState === STATES.HALF_OPEN) {
      this.halfOpenAttempts = 0;
      this.successCount = 0;
    } else if (newState === STATES.CLOSED) {
      this.failureCount = 0;
      this.successCount = 0;
    }

    console.log(`[CircuitBreaker] ${this.name}: ${oldState} -> ${newState}`);
  }

  /**
   * Get time until retry is allowed (when OPEN)
   * @returns {number} Milliseconds until retry, or 0 if not OPEN
   */
  getTimeUntilRetry() {
    if (this.state !== STATES.OPEN || !this.lastFailureTime) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.resetTimeout - elapsed);
  }

  /**
   * Get current circuit breaker status
   * @returns {Object} Status object
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      lastFailureTime: this.lastFailureTime,
      timeUntilRetry: this.getTimeUntilRetry(),
      metrics: { ...this.metrics }
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset() {
    this.transitionTo(STATES.CLOSED);
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenAttempts = 0;
  }

  /**
   * Force the circuit open (for maintenance/testing)
   */
  trip() {
    this.lastFailureTime = Date.now();
    this.transitionTo(STATES.OPEN);
  }
}

/**
 * Custom error for circuit breaker rejections
 */
class CircuitBreakerError extends Error {
  constructor(message, serviceName, state, retryAfter) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.serviceName = serviceName;
    this.circuitState = state;
    this.retryAfter = retryAfter;
    this.isCircuitBreakerError = true;
    this.isOverloaded = true;
  }
}

// Circuit breaker instances for each external service
const circuitBreakers = {
  geckoTerminal: new CircuitBreaker({
    name: 'geckoTerminal',
    failureThreshold: 5,
    resetTimeout: 30000,
    // Only count 5xx errors and timeouts as failures, not 429 (rate limit)
    isFailure: (error) => {
      if (error.response?.status === 429) return false; // Rate limit handled by queue
      if (error.response?.status >= 500) return true;
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return true;
      if (error.message?.includes('timeout')) return true;
      return error.response?.status >= 500 || !error.response;
    }
  }),

  jupiter: new CircuitBreaker({
    name: 'jupiter',
    failureThreshold: 5,
    resetTimeout: 30000,
    isFailure: (error) => {
      if (error.response?.status === 429) return false;
      return error.response?.status >= 500 || !error.response;
    }
  }),

  helius: new CircuitBreaker({
    name: 'helius',
    failureThreshold: 5,
    resetTimeout: 30000,
    isFailure: (error) => {
      if (error.response?.status === 429) return false;
      return error.response?.status >= 500 || !error.response;
    }
  }),

  solanaRpc: new CircuitBreaker({
    name: 'solanaRpc',
    failureThreshold: 3, // RPC failures are more critical
    resetTimeout: 20000,
    isFailure: (error) => {
      // RPC errors, timeouts, and connection issues
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return true;
      if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') return true;
      if (error.message?.includes('timeout')) return true;
      return false; // RPC-level errors (like invalid params) don't trip the breaker
    }
  }),

  raydium: new CircuitBreaker({
    name: 'raydium',
    failureThreshold: 5,
    resetTimeout: 30000,
    isFailure: (error) => {
      if (error.response?.status === 429) return false;
      return error.response?.status >= 500 || !error.response;
    }
  })
};

/**
 * Get all circuit breaker statuses
 * @returns {Object} Map of service name to status
 */
function getAllStatuses() {
  const statuses = {};
  for (const [name, breaker] of Object.entries(circuitBreakers)) {
    statuses[name] = breaker.getStatus();
  }
  return statuses;
}

/**
 * Check if a service is available
 * @param {string} serviceName Name of the service
 * @returns {boolean} True if service is available (CLOSED or HALF_OPEN)
 */
function isServiceAvailable(serviceName) {
  const breaker = circuitBreakers[serviceName];
  if (!breaker) return true;
  return breaker.state !== STATES.OPEN;
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerError,
  circuitBreakers,
  getAllStatuses,
  isServiceAvailable,
  STATES
};
