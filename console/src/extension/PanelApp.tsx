import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  conflictFromError,
  fetchAutomationStatus,
  fetchChanges,
  fetchMemoryItems,
  formatAge,
  formatReviewAge,
  postItemAction,
} from "../api";
import type {
  AutomationStatus,
  ChangeEvent,
  Health,
  MemoryItem,
} from "../types";
import { connectionHint } from "./errors";
import { Icon, LogoMark } from "./Icon";
import { startPolling } from "./poll";
import { axisChips } from "../pages/status-model";
import { changeLabel } from "../pages/memory-model";
import {
  addItemActionLock,
  isActionLocked,
  itemActionLockScope,
  unknownLockFor,
  unknownOutcomeChanged,
  unlockUnknownLocks,
  useItemActionLocks,
} from "../pages/item-action-locks";

export function PanelApp() {
  const [health, setHealth] = useState<Health>();
  const [automation, setAutomation] = useState<AutomationStatus>();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [changes, setChanges] = useState<ChangeEvent[]>([]);
  const [itemsKnown, setItemsKnown] = useState(false);
  const [changesKnown, setChangesKnown] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const lockScope = itemActionLockScope(health);
  const actionLocks = useItemActionLocks(lockScope);
  const actionLockCount = Object.keys(actionLocks.locks).length;
  const isUnknown = (itemID: string) => Boolean(unknownLockFor(actionLocks, itemID));
  const actionLocked = (
    itemID: string,
    version: string,
    action: "deactivate" | "reactivate" | "revert",
    changeID?: string,
  ) => isActionLocked(actionLocks.locks, itemID, action, version, changeID);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [healthResult, automationResult, itemResult, changeResult] =
        await Promise.allSettled([
          api<Health>("/api/health"),
          fetchAutomationStatus(),
          fetchMemoryItems({ includeArchived: true }),
          fetchChanges(40),
        ]);
      if (healthResult.status === "rejected") throw healthResult.reason;
      setHealth(healthResult.value);
      setAutomation(
        automationResult.status === "fulfilled" ? automationResult.value : undefined,
      );
      if (itemResult.status === "fulfilled") {
        setItems(itemResult.value);
        setItemsKnown(true);
      } else {
        setItems([]);
        setItemsKnown(false);
      }
      if (changeResult.status === "fulfilled") {
        setChanges(changeResult.value);
        setChangesKnown(true);
      } else {
        setChanges([]);
        setChangesKnown(false);
      }
      setError(null);
    } catch (caught: unknown) {
      setAutomation(undefined);
      setItems([]);
      setChanges([]);
      setItemsKnown(false);
      setChangesKnown(false);
      setError(toApiError(caught));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => startPolling(load, 5_000), [load]);

  useEffect(() => {
    if (actionLockCount === 0 || actionLocks.persistence === "available") return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [actionLockCount, actionLocks.persistence]);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const target = actionRefs.current.get(pendingFocus.current);
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else feedbackRef.current?.focus({ preventScroll: true });
    pendingFocus.current = null;
  }, [focusTick]);

  async function mutate(
    item: MemoryItem,
    action: "deactivate" | "reactivate" | "revert",
    changeID?: string,
  ) {
    if (
      busy ||
      verifying ||
      isUnknown(item.id) ||
      actionLocked(item.id, item.version, action, changeID)
    ) {
      return;
    }
    setBusy(`${item.id}:${action}`);
    setMessage("");
    setOpenFailed(false);
    setError(null);
    const focusKey =
      action === "deactivate"
        ? `${item.id}:reactivate`
        : `${item.id}:deactivate`;
    try {
      const result = await postItemAction(item.id, action, {
        expectedVersion: item.version,
        ...(changeID ? { changeID } : {}),
        ...(action === "deactivate" ? { reason: "user-deactivated" } : {}),
      });
      if (!result.ok) {
        setError(new ApiError(409, result.message));
        return;
      }
      setMessage(
        action === "deactivate"
          ? `已停止「${item.title}」，下一次模型请求起不再注入（含旧会话）。`
          : action === "reactivate"
            ? `已恢复「${item.title}」，下一次模型请求起重新注入。`
            : `已撤销「${item.title}」的这次变更。`,
      );
      await load();
      pendingFocus.current = focusKey;
      setFocusTick((value) => value + 1);
    } catch (caught: unknown) {
      const conflict = conflictFromError(caught);
      if (conflict) {
        addItemActionLock(lockScope, {
          itemID: item.id,
          action,
          version: item.version,
          ...(changeID ? { changeID } : {}),
          kind: "conflict",
        });
        setError(
          new ApiError(
            409,
            action === "revert"
              ? conflict.code === "not_revertible"
                ? "该版本不可回退（可能已撤销或超期）；只能回到完整控制台停止使用。"
                : "当前已被修改，无法安全撤销；只能回到完整控制台停止使用。"
              : `${action === "deactivate" ? "停止" : "恢复"}未执行：${conflict.message}${
                  conflict.version
                    ? `；服务端最新版本 ${conflict.version.slice(0, 8)}`
                    : ""
                }。请刷新后再试。`,
          ),
        );
      } else {
        const apiError = toApiError(caught);
        if (apiError.code === "OPENMEM_OUTCOME_UNKNOWN" || apiError.status === 504) {
          addItemActionLock(lockScope, {
            itemID: item.id,
            action,
            version: item.version,
            ...(changeID ? { changeID } : {}),
            kind: "unknown",
          });
          setError(
            new ApiError(
              504,
              "操作结果未知：已停止重复提交，请先核对服务端最新版本。",
              "OPENMEM_OUTCOME_UNKNOWN",
            ),
          );
        } else {
          setError(apiError);
        }
      }
    } finally {
      setBusy(undefined);
    }
  }

  async function recheckUnknown(itemID: string) {
    if (verifying) return;
    const lock = unknownLockFor(actionLocks, itemID);
    if (!lock) {
      setError(new ApiError(0, "核对失败：缺少本次提交前的共享锁基线，保持锁定。"));
      return;
    }
    setVerifying(true);
    try {
      const rows = await fetchMemoryItems({ includeArchived: true });
      const fresh = rows.find((item) => item.id === itemID);
      if (!fresh) {
        setError(new ApiError(0, "核对失败：服务端暂未返回该条目，保持锁定。"));
        return;
      }
      setItems(rows);
      setItemsKnown(true);
      const changed = unknownOutcomeChanged(lock, {
        version: fresh.version,
        changeID: fresh.changeID,
      });
      unlockUnknownLocks(lockScope, itemID);
      setMessage(
        changed
          ? "已核对：服务端已有新版本，操作可能已生效；已按最新状态刷新。"
          : "已核对：服务端版本未变化，未确认已提交；已解除锁定。",
      );
      setError(null);
      void load();
    } catch (caught: unknown) {
      setError(new ApiError(0, `核对失败：${toApiError(caught).message}；保持锁定。`));
    } finally {
      setVerifying(false);
    }
  }

  async function openConsole() {
    if (opening) return;
    setOpening(true);
    setOpenFailed(false);
    setMessage("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(
        "/api/console/open",
        { method: "POST" },
      );
      if (!result.ok) {
        setOpenFailed(true);
        setMessage(
          result.error ?? "宿主没有打开完整控制台；请用侧边栏 → 扩展页面。",
        );
        return;
      }
      setMessage("已请求宿主打开完整控制台；若未出现，请用侧边栏 → 扩展页面。");
    } catch (caught: unknown) {
      setOpenFailed(true);
      setMessage(
        toApiError(caught).status === 501
          ? "请从 OpenChamber 侧边栏 → 扩展页面打开完整控制台。"
          : `无法打开完整控制台：${toApiError(caught).message}`,
      );
    } finally {
      setOpening(false);
    }
  }

  if (!loaded) {
    return (
      <div className="op-panel" aria-busy="true">
        <PanelHead online={false} />
        <div className="op-skeleton" />
        <div className="op-skeleton short" />
        <div className="op-skeleton" />
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="op-panel">
        <PanelHead online={false} />
        <div className="op-error-card">
          <span className="op-error-icon" aria-hidden="true">
            <Icon name="alert" size={18} />
          </span>
          <strong>暂时无法连接 OpenMem</strong>
          <p>{error.message}</p>
          <p className="op-hint">{connectionHint(error)}</p>
          <button className="op-btn primary" type="button" onClick={() => void load()}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        </div>
        <PanelFoot onRefresh={load} onOpen={openConsole} opening={opening} />
      </div>
    );
  }

  const chips = axisChips(automation);
  const active = items.filter((item) => item.stoppable).slice(0, 3);
  const unknownItem = items.find((item) => isUnknown(item.id));
  const activeCount = items.filter((item) => item.stoppable).length;
  const versions = new Map(items.map((item) => [item.id, item]));
  const recentOps = [...changes].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 3);

  return (
    <div className="op-panel">
      <PanelHead online={!error} />

      <section className="op-axes" aria-label="运行状态（三轴独立）">
        {chips.map((chip) => (
          <span className={`op-axis ${chip.tone}`} key={chip.key} title={chip.detail}>
            <i aria-hidden="true" />
            {chip.label}
          </span>
        ))}
      </section>

      <section className="op-list" aria-label="最近写入">
        <div className="op-list-head">
          <span>最近写入</span>
          <span>{itemsKnown ? activeCount : "未知"}</span>
        </div>
        {active.map((item) => {
          const key = `${item.id}:deactivate`;
          return (
            <article className="op-row" key={item.id}>
              <div className="op-row-copy">
                <strong title={item.title}>{item.title}</strong>
                <span>
                  {item.scope} · {item.kind} · {formatAge(item.updatedAt)}
                </span>
              </div>
              {isUnknown(item.id) ? (
                <button
                  className="op-btn row-action"
                  type="button"
                  disabled={verifying}
                  onClick={() => void recheckUnknown(item.id)}
                >
                  {verifying ? "核对中…" : "核对"}
                </button>
              ) : (
                <button
                  className="op-btn row-action"
                  type="button"
                  ref={(node) => {
                    const key = `${item.id}:deactivate`;
                    if (node) actionRefs.current.set(key, node);
                    else actionRefs.current.delete(key);
                  }}
                  disabled={
                    busy !== undefined ||
                    verifying ||
                    !itemsKnown ||
                    actionLocked(item.id, item.version, "deactivate")
                  }
                  onClick={() => void mutate(item, "deactivate")}
                >
                  {busy === key ? "停止中…" : "停止使用"}
                </button>
              )}
            </article>
          );
        })}
        {active.length === 0 ? (
          <div className="op-empty">
            <strong>{itemsKnown ? "还没有生效记忆" : "记忆数量未知"}</strong>
            <span>
              {itemsKnown
                ? "自动写入开启后，符合条件的候选会直接出现在这里。"
                : "记忆列表读取失败；不显示 0 条。"}
            </span>
          </div>
        ) : null}
      </section>

      <section className="op-list" aria-label="最近操作">
        <div className="op-list-head">
          <span>最近操作</span>
          <span>可恢复 / 撤销</span>
        </div>
        {recentOps.map((change) => {
          const item = versions.get(change.itemID);
          const title =
            change.after?.title ||
            change.before?.title ||
            item?.title ||
            `条目 ${change.itemID.slice(0, 8)}`;
          const canRestore = item?.restorable === true;
          const isLatest = item?.latestChange?.id === change.id;
          const canRevert =
            isLatest && change.revertible === true && item?.revertible === true;
          return (
            <article className="op-row" key={change.id}>
              <div className="op-row-copy">
                <strong title={title}>{title}</strong>
                <span>
                  {changeLabel(change)} · {formatReviewAge(change.at)}
                </span>
              </div>
              {item && isUnknown(item.id) ? (
                <button
                  className="op-btn row-action"
                  type="button"
                  disabled={verifying}
                  onClick={() => void recheckUnknown(item.id)}
                >
                  {verifying ? "核对中…" : "核对"}
                </button>
              ) : canRestore ? (
                <button
                  className="op-btn row-action"
                  type="button"
                  ref={(node) => {
                    const key = `${item!.id}:reactivate`;
                    if (node) actionRefs.current.set(key, node);
                    else actionRefs.current.delete(key);
                  }}
                  disabled={
                    busy !== undefined ||
                    verifying ||
                    !itemsKnown ||
                    actionLocked(item!.id, item!.version, "reactivate")
                  }
                  onClick={() => void mutate(item!, "reactivate")}
                >
                  {busy === `${item?.id}:reactivate` ? "恢复中…" : "恢复"}
                </button>
              ) : canRevert ? (
                <button
                  className="op-btn row-action"
                  type="button"
                  ref={(node) => {
                    const key = `${item!.id}:revert`;
                    if (node) actionRefs.current.set(key, node);
                    else actionRefs.current.delete(key);
                  }}
                  disabled={
                    busy !== undefined ||
                    verifying ||
                    !itemsKnown ||
                    actionLocked(
                      item!.id,
                      item!.version,
                      "revert",
                      change.id,
                    )
                  }
                  onClick={() => void mutate(item!, "revert", change.id)}
                >
                  {busy === `${item?.id}:revert` ? "撤销中…" : "撤销"}
                </button>
              ) : (
                <span className="op-tag">{change.actor === "user" ? "你" : "自动"}</span>
              )}
            </article>
          );
        })}
        {recentOps.length === 0 ? (
          <div className="op-empty">
            <strong>{changesKnown ? "还没有操作记录" : "操作记录未知"}</strong>
            <span>
              {changesKnown
                ? "停止、恢复和撤销都会保留在这里。"
                : "活动账本读取失败；不显示 0 条。"}
            </span>
          </div>
        ) : null}
      </section>

      {message ? (
        <p
          className={`op-message${openFailed ? " error" : ""}`}
          ref={feedbackRef}
          tabIndex={-1}
          role={openFailed ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
      {error && health ? (
        <div className="op-warning">
          <Icon name="alert" size={14} />
          <span>{error.message}</span>
          {unknownItem ? (
            <button
              type="button"
              disabled={verifying}
              onClick={() => void recheckUnknown(unknownItem.id)}
            >
              {verifying ? "核对中…" : "核对最新版本"}
            </button>
          ) : (
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          )}
        </div>
      ) : null}

      <p className="op-legacy">
        审查（legacy）在完整控制台 › 设置 › 高级与维护；普通自动记忆不会进入审批。
      </p>
      {actionLockCount > 0 && actionLocks.persistence === "unavailable" ? (
        <p className="op-legacy" role="status">
          操作锁无法跨刷新持久化；刷新前请先核对未知结果。
        </p>
      ) : null}

      <PanelFoot onRefresh={load} onOpen={openConsole} opening={opening} />
    </div>
  );
}

function PanelHead({ online }: { online: boolean }) {
  return (
    <header className="op-head">
      <span className="op-logo" aria-hidden="true">
        <LogoMark size={30} />
      </span>
      <span className="op-title">
        <strong>OpenMem</strong>
        <small>记忆自动巡航</small>
      </span>
      <span
        className={`op-dot ${online ? "ok" : "off"}`}
        title={online ? "运行中" : "离线"}
        aria-label={online ? "运行中" : "离线"}
      />
    </header>
  );
}

function PanelFoot({
  onRefresh,
  onOpen,
  opening,
}: {
  onRefresh: () => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  opening: boolean;
}) {
  return (
    <footer className="op-foot">
      <button className="op-btn" type="button" disabled={opening} onClick={() => void onOpen()}>
        {opening ? "正在打开…" : "打开控制台"}
      </button>
      <span className="op-spacer" />
      <button
        className="op-icon-btn"
        type="button"
        aria-label="刷新"
        title="刷新"
        onClick={() => void onRefresh()}
      >
        <Icon name="refresh" size={14} />
      </button>
    </footer>
  );
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, error instanceof Error ? error.message : String(error));
}
