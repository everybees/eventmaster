const KEY = "wpg.deviceId";

/** A random ID for this browser, made on first use. It ties interactions together without knowing who anyone is. */
export function deviceId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** After "delete my data": the next interaction starts a fresh, unconnected history. */
export function resetDeviceId(): void {
  localStorage.removeItem(KEY);
}
