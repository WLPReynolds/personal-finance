/**
 * v0.14: one Google sign-in for two sync engines (personal + joint).
 *
 * Google's token client has ONE callback: if two engines each asked for a
 * token in the same tap, the second request would take over the first's
 * callback and the first would wait until it timed out. So while a request is
 * running, every other caller gets the same promise. The request itself still
 * starts synchronously inside the tap (Android rule — see google-auth.js).
 */
export function shareTokenRequests(auth) {
  let pending = null;
  function getToken(opts) {
    if (pending) return pending;
    const p = auth.getToken(opts);
    if (!opts?.interactive) return p;
    pending = Promise.resolve(p).finally(() => { if (pending === shared) pending = null; });
    const shared = pending;
    return shared;
  }
  return new Proxy(auth, {
    get(target, prop) {
      if (prop === 'getToken') return getToken;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
