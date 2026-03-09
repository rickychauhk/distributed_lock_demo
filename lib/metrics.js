/**
 * Simple in-memory metrics for checkout outcomes and lock hold time.
 */

const LOCK_HOLD_SAMPLES = 100;

let checkoutSuccess = 0;
let checkoutLocked = 0;
let checkoutFailed = 0;
const lockHoldMsSamples = [];

function incrementSuccess() {
  checkoutSuccess += 1;
}

function incrementLocked() {
  checkoutLocked += 1;
}

function incrementFailed() {
  checkoutFailed += 1;
}

function recordLockHoldMs(ms) {
  lockHoldMsSamples.push(ms);
  if (lockHoldMsSamples.length > LOCK_HOLD_SAMPLES) lockHoldMsSamples.shift();
}

function getAvgLockHoldMs() {
  if (lockHoldMsSamples.length === 0) return null;
  const sum = lockHoldMsSamples.reduce((a, b) => a + b, 0);
  return Math.round(sum / lockHoldMsSamples.length);
}

function get() {
  return {
    checkoutSuccess,
    checkoutLocked,
    checkoutFailed,
    avgLockHoldMs: getAvgLockHoldMs(),
  };
}

module.exports = {
  incrementSuccess,
  incrementLocked,
  incrementFailed,
  recordLockHoldMs,
  get,
};
