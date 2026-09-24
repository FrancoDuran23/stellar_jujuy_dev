// Per-channel mutex (design 4.3; spec VE-R12; T5.1). A promise chain in a
// `Map<string, Promise<void>>`, no external dependency, scoped to a single
// process (design 4.3: two server instances would need a real distributed
// lock, explicitly out of scope — 4.10).
//
// Relocated from `agent/mutex.ts` to `shared/` in WU7 (Lote E) so
// `server/channel-service.ts` can serialize its own per-channel accept/close
// operations with the same primitive `agent/routes/vouchers.ts` uses for
// coalescing, without the server importing from the agent module (design
// 4.1's folder boundary: "shared/ es el único módulo que importan tanto
// agent/ como server/"). `agent/mutex.ts` re-exports this file unchanged so
// no existing import breaks.

export type ChannelMutex = {
  /**
   * Runs `fn` after every previously-queued `withChannelLock` call for the
   * same `channel` has settled (succeeded or failed), and before any call
   * queued after it starts. Calls for different channels never block each
   * other. The caller receives `fn`'s real resolution or rejection; a
   * failure never poisons the chain for the next queued call on the same
   * channel.
   */
  withChannelLock<T>(channel: string, fn: () => Promise<T>): Promise<T>;
};

export function createChannelMutex(): ChannelMutex {
  // Each entry is a promise that always resolves (never rejects) once the
  // call it represents has settled — that is what lets `.then()` on it
  // reliably start the next queued call even after a failure.
  const chains = new Map<string, Promise<void>>();

  function withChannelLock<T>(channel: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(channel) ?? Promise.resolve();

    let release: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    chains.set(channel, settled);

    const result = previous.then(fn);
    // A separate promise chain, deliberately not the one returned to the
    // caller: `.finally()` here returns its own promise that would
    // otherwise carry an unhandled rejection whenever `fn` throws — the
    // trailing `.catch(() => {})` exists only to silence that duplicate,
    // never to swallow the error for the actual caller (`result`, returned
    // below, keeps `fn`'s real resolution or rejection).
    result
      .finally(() => {
        release();
        // Nothing queued behind us: drop the entry so a channel that is
        // only used occasionally does not grow the map forever.
        if (chains.get(channel) === settled) {
          chains.delete(channel);
        }
      })
      .catch(() => {});

    return result;
  }

  return { withChannelLock };
}
