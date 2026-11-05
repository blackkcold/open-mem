function isOnScreen(): boolean {
  if (document.hidden) return false;
  const rect = document.documentElement.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Poll while the frame is actually visible. OpenChamber keeps iframes mounted
 * when the user switches rail tabs, so `document.hidden` alone is not enough.
 */
export function startPolling(
  tick: () => void | Promise<void>,
  intervalMs: number,
): () => void {
  let stopped = false;
  let inflight = false;
  let visible = isOnScreen();

  const run = async (): Promise<void> => {
    if (stopped || inflight || !isOnScreen()) return;
    inflight = true;
    try {
      await tick();
    } finally {
      inflight = false;
    }
  };

  const timer = window.setInterval(() => {
    void run();
  }, intervalMs);

  const check = (): void => {
    const next = isOnScreen();
    if (next && !visible) void run();
    visible = next;
  };

  document.addEventListener("visibilitychange", check);
  const observer =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(check);
  observer?.observe(document.documentElement);
  void run();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", check);
    observer?.disconnect();
  };
}
