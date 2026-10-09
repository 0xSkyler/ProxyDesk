import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import type { WorkspaceState } from '../../shared/types/workspace';
import type { WorkspaceInputEvent, WorkspacePointerButton } from '../../shared/types/interaction';
import { composePlaywrightShortcut, mapLiveViewPoint } from '../../shared/liveView';
import { useAppStore } from '../stores/appStore';

function pointerButton(button: number): WorkspacePointerButton {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

function BrowserPreviewCard({ workspace }: { workspace: WorkspaceState }) {
  const cardRef = useRef<HTMLElement | null>(null);
  const liveViewRef = useRef<HTMLDivElement | null>(null);
  const pointerDownRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const lastMoveAtRef = useRef(0);
  const inputRefreshTimerRef = useRef<number | undefined>(undefined);
  const wheelFlushTimerRef = useRef<number | undefined>(undefined);
  const wheelDeltaRef = useRef({ x: 0, y: 0 });
  const addressEditingRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const previewFrame = useAppStore((s) => s.previews[workspace.id]);
  const [localPreviewError, setLocalPreviewError] = useState<string>();
  const [interactionActive, setInteractionActive] = useState(false);
  const [addressDraft, setAddressDraft] = useState(workspace.url);

  const running = ['ready', 'loading', 'rotating', 'launching'].includes(workspace.status);
  const preview = running ? previewFrame?.dataUrl : undefined;
  const previewError = localPreviewError ?? (running ? previewFrame?.error : undefined);
  const frameLatencyMs = previewFrame?.latencyMs;
  const lastFrameAt = previewFrame?.capturedAt;

  const scheduleInputRefresh = useCallback((delay = 40) => {
    if (inputRefreshTimerRef.current !== undefined) window.clearTimeout(inputRefreshTimerRef.current);
    inputRefreshTimerRef.current = window.setTimeout(() => {
      void window.proxydesk.workspace.requestPreview(workspace.id).catch(() => undefined);
      inputRefreshTimerRef.current = undefined;
    }, delay);
  }, [workspace.id]);

  const sendInput = useCallback(async (event: WorkspaceInputEvent, refreshDelay = 120) => {
    try {
      await window.proxydesk.workspace.input(workspace.id, event);
      setLocalPreviewError(undefined);
      scheduleInputRefresh(refreshDelay);
    } catch (error) {
      setLocalPreviewError(error instanceof Error ? error.message : 'Browser input failed.');
    }
  }, [scheduleInputRefresh, workspace.id]);

  const pointFromEvent = useCallback((event: { clientX: number; clientY: number }) => {
    const element = liveViewRef.current;
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    return mapLiveViewPoint(event.clientX, event.clientY, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  }, []);

  useEffect(() => {
    if (!addressEditingRef.current) setAddressDraft(workspace.url);
  }, [workspace.url]);

  useEffect(() => () => {
    if (inputRefreshTimerRef.current !== undefined) window.clearTimeout(inputRefreshTimerRef.current);
    if (wheelFlushTimerRef.current !== undefined) window.clearTimeout(wheelFlushTimerRef.current);
  }, []);

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    setVisible(rect.bottom >= -280 && rect.top <= window.innerHeight + 280);

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: '280px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const mode = !running ? 'hidden' : interactionActive ? 'active' : visible ? 'visible' : 'hidden';
    void window.proxydesk.workspace.setPreviewMode(workspace.id, mode).catch((error) => {
      setLocalPreviewError(error instanceof Error ? error.message : 'Live view stream failed.');
    });
    if (mode !== 'hidden') void window.proxydesk.workspace.requestPreview(workspace.id).catch(() => undefined);
    return () => { void window.proxydesk.workspace.setPreviewMode(workspace.id, 'hidden').catch(() => undefined); };
  }, [workspace.id, running, visible, interactionActive]);

  useEffect(() => {
    if (running && visible) void window.proxydesk.workspace.requestPreview(workspace.id).catch(() => undefined);
  }, [workspace.id, workspace.url, running, visible]);

  useEffect(() => {
    if (!running) {
      setInteractionActive(false);
      setLocalPreviewError(undefined);
    }
  }, [running]);

  const activateInteraction = () => {
    setInteractionActive(true);
    liveViewRef.current?.focus({ preventScroll: true });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!running || !preview) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    activateInteraction();
    pointerDownRef.current = true;
    lastPointRef.current = point;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    void sendInput({ kind: 'pointer', action: 'down', x: point.x, y: point.y, button: pointerButton(event.button) }, 90);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!running || !preview || !interactionActive) return;
    const now = performance.now();
    if (now - lastMoveAtRef.current < 60) return;
    lastMoveAtRef.current = now;
    const point = pointFromEvent(event);
    if (!point) return;
    lastPointRef.current = point;
    void window.proxydesk.workspace.input(workspace.id, {
      kind: 'pointer', action: 'move', x: point.x, y: point.y, button: pointerButton(event.button)
    }).catch(() => undefined);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!running || !preview || !pointerDownRef.current) return;
    pointerDownRef.current = false;
    const point = pointFromEvent(event) ?? lastPointRef.current;
    if (!point) return;
    lastPointRef.current = point;
    event.preventDefault();
    void sendInput({ kind: 'pointer', action: 'up', x: point.x, y: point.y, button: pointerButton(event.button) }, 100);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!interactionActive || !running || !preview) return;
    event.preventDefault();
    event.stopPropagation();

    // Trackpads can emit hundreds of wheel events per second. Coalesce them into
    // short bursts so IPC and Playwright never build an unbounded input queue.
    wheelDeltaRef.current.x += event.deltaX;
    wheelDeltaRef.current.y += event.deltaY;
    if (wheelFlushTimerRef.current !== undefined) return;
    wheelFlushTimerRef.current = window.setTimeout(() => {
      wheelFlushTimerRef.current = undefined;
      const delta = wheelDeltaRef.current;
      wheelDeltaRef.current = { x: 0, y: 0 };
      void sendInput({ kind: 'wheel', deltaX: delta.x, deltaY: delta.y }, 70);
    }, 32);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactionActive || !running || !preview) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setInteractionActive(false);
      liveViewRef.current?.blur();
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      void sendInput({ kind: 'text', text: event.key }, 80);
      return;
    }
    const key = composePlaywrightShortcut(event.key, {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey
    });
    void sendInput({ kind: 'key', key }, 90);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!interactionActive || !running || !preview) return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    void sendInput({ kind: 'text', text }, 90);
  };

  const navigateAddress = async () => {
    const value = addressDraft.trim();
    if (!value) return;
    try {
      await window.proxydesk.workspace.navigate(workspace.id, value);
      setLocalPreviewError(undefined);
      scheduleInputRefresh(200);
    } catch (error) {
      setLocalPreviewError(error instanceof Error ? error.message : 'Navigation failed.');
    }
  };

  const proxyLabel = workspace.proxy ? `${workspace.proxy.host}:${workspace.proxy.port}` : 'Direct / none';

  return <article className="browser-wall-card" ref={cardRef}>
    <header className="browser-wall-card-head">
      <div><span className="workspace-number">{workspace.id}</span><div><strong>Browser {workspace.id}</strong><small>{workspace.engineLabel}</small></div></div>
      <span className={`pill ${workspace.status}`}>{workspace.status}</span>
    </header>

    <div className="browser-chrome browser-chrome-interactive">
      <span className="browser-dot" /><span className="browser-dot" /><span className="browser-dot" />
      <form className="browser-address-form" onSubmit={(event) => { event.preventDefault(); void navigateAddress(); }}>
        <input
          className="browser-address-input"
          aria-label={`Browser ${workspace.id} address`}
          value={addressDraft}
          onFocus={() => { addressEditingRef.current = true; }}
          onBlur={() => { addressEditingRef.current = false; }}
          onChange={(event) => setAddressDraft(event.target.value)}
          spellCheck={false}
        />
        <button type="submit" disabled={!addressDraft.trim()}>Go</button>
      </form>
    </div>

    <div
      className={`browser-live-view interactive-live-view ${interactionActive ? 'interaction-active' : ''}`}
      ref={liveViewRef}
      tabIndex={running && preview ? 0 : -1}
      role="application"
      aria-label={`Interactive live view for Browser ${workspace.id}. Click to control, Escape to release input.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={(event) => {
        if (pointerDownRef.current && lastPointRef.current) {
          const point = lastPointRef.current;
          void window.proxydesk.workspace.input(workspace.id, { kind: 'pointer', action: 'up', x: point.x, y: point.y, button: pointerButton(event.button) }).catch(() => undefined);
        }
        pointerDownRef.current = false;
      }}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onContextMenu={(event) => { if (running && preview) event.preventDefault(); }}
      onBlur={() => setInteractionActive(false)}
    >
      {preview ? (
        <img src={preview} draggable={false} title={lastFrameAt ? `Frame ${lastFrameAt}` : undefined} alt={`Live view for Browser ${workspace.id}`} onError={() => { setLocalPreviewError('The preview image could not be rendered.'); }} />
      ) : (
        <div className="browser-preview-empty">
          <strong>{running ? (previewError ? 'Live view unavailable' : 'Connecting live view…') : 'Browser stopped'}</strong>
          <span>{running ? (previewError ?? 'The viewport will appear here as soon as the page renders.') : 'Launch this browser to render it inside ProxyDesk.'}</span>
        </div>
      )}
      <div className={`live-badge ${preview ? 'connected' : ''}`}><span /> {preview ? `LIVE ${frameLatencyMs ?? '—'}ms` : 'CONNECTING'}</div>
      {preview && <div className={`interaction-badge ${interactionActive ? 'active' : ''}`}>{interactionActive ? 'INTERACTIVE · ESC RELEASES' : 'CLICK TO CONTROL'}</div>}
    </div>

    <div className="browser-wall-meta">
      <div><span>Proxy</span><strong title={proxyLabel}>{proxyLabel}</strong></div>
      <div><span>Keep Alive</span><strong>{workspace.keepAlive ? `ON · ${workspace.visitedLinks} hops` : 'OFF'}</strong></div>
      <div><span>Rotation</span><strong>{workspace.rotationSeconds ? `${workspace.rotationSeconds}s` : 'Off'}</strong></div>
    </div>

    {workspace.error && <div className="card-error browser-wall-error">{workspace.error}</div>}

    <div className="browser-wall-actions">
      {!running ? <button className="primary" disabled={!workspace.engineAvailable} onClick={() => void window.proxydesk.workspace.launch(workspace.id)}>Launch</button> : <button className="danger-ghost" onClick={() => void window.proxydesk.workspace.stop(workspace.id)}>Stop</button>}
      <button disabled={!running} onClick={() => void window.proxydesk.workspace.reload(workspace.id)}>Reload</button>
      <button onClick={() => void window.proxydesk.workspace.setKeepAlive(workspace.id, !workspace.keepAlive)}>{workspace.keepAlive ? 'Keep Alive off' : 'Keep Alive on'}</button>
      <button disabled={!running} onClick={() => { setLocalPreviewError(undefined); void window.proxydesk.workspace.requestPreview(workspace.id); }}>Refresh view</button>
    </div>
  </article>;
}

export function WorkspaceCards() {
  const workspaces = useAppStore((s) => s.workspaces);
  return <section className="browser-wall-grid">{workspaces.map((workspace) => <BrowserPreviewCard workspace={workspace} key={workspace.id} />)}</section>;
}
