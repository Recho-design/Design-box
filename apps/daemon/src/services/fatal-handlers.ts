// Process-wide fatal-error handlers for the daemon.
//
// A daemon that keeps serving requests after an invariant broke produces wrong
// results instead of a clean failure, so an uncaught exception or an unhandled
// rejection has to end the process — and it has to leave a readable trace
// first. The exit path is local-only: the error is formatted to stderr and the
// process exits non-zero.
//
// Nothing here may throw — a handler that throws while handling a fatal error
// replaces the original error with its own and loses the evidence.
//
// Local-only by construction: this module reads no config, opens no file and
// performs no I/O beyond stderr.

const FATAL_STACK_LIMIT = 8192;

interface NormalizedFatalError {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
}

function normalizeFatalError(reason: unknown): NormalizedFatalError {
  const error = reason instanceof Error ? reason : null;
  if (error) {
    return {
      errorName: error.name || 'Error',
      errorMessage: error.message || String(error),
      ...(typeof error.stack === 'string'
        ? { errorStack: error.stack.slice(0, FATAL_STACK_LIMIT) }
        : {}),
    };
  }
  return {
    // A rejected promise may carry anything; name the shape honestly rather
    // than dressing a string up as an `Error`.
    errorName: 'NonErrorRejection',
    errorMessage: typeof reason === 'string' ? reason : String(reason),
  };
}

/**
 * Install the daemon's fatal handlers and return the disposer.
 *
 * The first fatal signal wins: a second one arriving while the process is
 * already on its way out must not start a competing exit path.
 */
export function installFatalHandlers(): () => void {
  let fatalShuttingDown = false;

  const triggerFatalShutdown = (eventName: string, reason: unknown): void => {
    if (fatalShuttingDown) return;
    fatalShuttingDown = true;
    const fatal = normalizeFatalError(reason);
    console.error(`[od] fatal: ${eventName}`);
    console.error(`  error_name: ${fatal.errorName}`);
    console.error(`  error_message: ${fatal.errorMessage}`);
    if (fatal.errorStack) console.error(`  error_stack:\n${fatal.errorStack}`);
    process.exit(1);
  };

  const onUncaughtException = (error: Error): void => {
    triggerFatalShutdown('daemon_uncaught_exception', error);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    triggerFatalShutdown('daemon_unhandled_rejection', reason);
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}
