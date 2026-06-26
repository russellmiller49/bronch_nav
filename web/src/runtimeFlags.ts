declare const __ENABLE_SCOPE_DEBUG__: boolean;

export const ENABLE_SCOPE_DEBUG = __ENABLE_SCOPE_DEBUG__ || isLoopbackHost();

function isLoopbackHost() {
  if (typeof window === "undefined") {
    return false;
  }

  const hostname = window.location.hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
