// The Studio plugin's PathGuard adds these fields to a read response when a
// request path names more than one instance. Tool methods that rebuild the
// plugin response instead of passing it through must carry them over.
export interface PathNotice {
  ambiguousPaths?: unknown[];
  pathWarning?: string;
}

export function pathNotice(response: unknown): PathNotice {
  const notice: PathNotice = {};
  if (!response || typeof response !== 'object') return notice;
  if ('ambiguousPaths' in response && Array.isArray(response.ambiguousPaths)) {
    notice.ambiguousPaths = response.ambiguousPaths;
  }
  if ('pathWarning' in response && typeof response.pathWarning === 'string') {
    notice.pathWarning = response.pathWarning;
  }
  return notice;
}
