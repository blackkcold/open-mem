import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type Pending = ConfirmOptions & {
  resolve: (value: boolean) => void;
  returnFocus: HTMLElement | null;
};

let queue: Pending[] = [];
let notify: (() => void) | null = null;

/**
 * A promise-based confirmation that works in the extension iframe, where
 * `window.confirm` is disabled by the sandbox. It falls back to the native
 * dialog when no <ConfirmHost /> is mounted.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!notify) {
      resolve(window.confirm(options.message));
      return;
    }
    queue.push({ ...options, resolve, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
    notify();
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    notify = () => setPending(queue[0]);
    notify();
    return () => {
      notify = null;
      for (const entry of queue) entry.resolve(false);
      queue = [];
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(timer);
      if (root) root.inert = wasInert;
      const target = pending.returnFocus;
      if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true });
    };
  }, [pending]);

  function settle(value: boolean): void {
    const current = queue.shift();
    current?.resolve(value);
    setPending(queue[0]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      settle(false);
      return;
    }
    if (event.key !== "Tab") return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!pending || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) settle(false);
      }}
    >
      <div
        className="confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openmem-confirm-title"
        aria-describedby="openmem-confirm-message"
        onKeyDown={onKeyDown}
      >
        <div
          className="confirm-icon"
          data-tone={pending.danger ? "danger" : "info"}
          aria-hidden="true"
        >
          !
        </div>
        <div className="confirm-copy">
          <h2 id="openmem-confirm-title">{pending.title ?? "确认操作"}</h2>
          <p id="openmem-confirm-message">{pending.message}</p>
        </div>
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            className="btn ghost"
            type="button"
            onClick={() => settle(false)}
          >
            {pending.cancelLabel ?? "取消"}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${pending.danger ? "danger" : "primary"}`}
            type="button"
            onClick={() => settle(true)}
          >
            {pending.confirmLabel ?? "确认"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
