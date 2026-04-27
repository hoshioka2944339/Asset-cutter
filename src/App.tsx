import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { exportSinglePng, exportZip } from './download';
import { applyTransparency, cropSelection, detectAssetSelections, fitToOutput, getTransparentCropBounds } from './imageProcessing';
import { t } from './i18n';
import type { AssetSelection, CutterSettings, DetectionSettings, ExportSize, RGB, ScaleMode } from './types';

type ToolMode = 'select' | 'draw' | 'pan' | 'eyedropper';
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type DragState =
  | { type: 'new'; startX: number; startY: number; id: string }
  | { type: 'move'; id: string; offsetX: number; offsetY: number }
  | { type: 'move-all'; startX: number; startY: number; startSelections: AssetSelection[] }
  | { type: 'pan'; startClientX: number; startClientY: number; startOffsetX: number; startOffsetY: number }
  | { type: 'resize'; id: string; handle: Handle; start: AssetSelection; square: boolean };

const initialSettings: CutterSettings = {
  mode: 'edge',
  backgroundColor: { r: 255, g: 255, b: 255 },
  tolerance: 38,
  feather: 1,
  removeSpecks: true,
  reduceFringe: true,
  exportSize: { preset: '128', width: 128, height: 128 },
  scaleMode: 'fit',
  resizeMethod: 'smooth',
  pixelArtMode: false,
  padding: 12,
  autoTrim: true,
};

const initialDetectionSettings: DetectionSettings = {
  minArea: 500,
  mergeDistance: 20,
  padding: 8,
};

export const App = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const spacePressedRef = useRef(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageName, setImageName] = useState('');
  const [zoom, setZoom] = useState(1);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<ToolMode>('draw');
  const [selections, setSelections] = useState<AssetSelection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settings, setSettings] = useState<CutterSettings>(initialSettings);
  const [detectionSettings, setDetectionSettings] = useState<DetectionSettings>(initialDetectionSettings);
  const [squareLocked, setSquareLocked] = useState(false);
  const [trimPadding, setTrimPadding] = useState(0);
  const [moveAllSelections, setMoveAllSelections] = useState(false);
  const [outputAspectLocked, setOutputAspectLocked] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [isSavingSingle, setIsSavingSingle] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const activeSelection = useMemo(
    () => selections.find((selection) => selection.id === activeId) ?? selections[0],
    [activeId, selections],
  );

  useEffect(() => {
    drawEditor();
  }, [image, zoom, selections, activeId, settings.pixelArtMode]);

  useEffect(() => {
    if (!settings.pixelArtMode || settings.resizeMethod === 'nearest') return;
    setSettings((current) => ({ ...current, resizeMethod: 'nearest' }));
  }, [settings.pixelArtMode, settings.resizeMethod]);

  useEffect(() => {
    if (!settings.pixelArtMode) return;
    setSelections((current) => current.map(roundSelection));
  }, [settings.pixelArtMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'Space') {
        if (!isEditableTarget(event.target)) event.preventDefault();
        spacePressedRef.current = true;
        setSpacePressed(true);
      }
      if (!image || !activeSelection || !event.key.startsWith('Arrow')) return;
      if (isEditableTarget(event.target)) return;

      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      if (event.altKey) {
        if (squareLocked && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) resizeActive(step);
        if (squareLocked && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) resizeActive(-step);
        if (!squareLocked && event.key === 'ArrowRight') resizeActive(step, 'width');
        if (!squareLocked && event.key === 'ArrowLeft') resizeActive(-step, 'width');
        if (!squareLocked && event.key === 'ArrowDown') resizeActive(step, 'height');
        if (!squareLocked && event.key === 'ArrowUp') resizeActive(-step, 'height');
        return;
      }

      const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      nudgeActive(dx, dy);
    };

    window.addEventListener('keydown', onKeyDown);
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'Space') {
        if (!isEditableTarget(event.target)) event.preventDefault();
        spacePressedRef.current = false;
        setSpacePressed(false);
      }
    };
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [image, activeSelection, squareLocked]);

  const drawEditor = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!image) {
      canvas.width = 960;
      canvas.height = 640;
      ctx.fillStyle = '#fafaf8';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    canvas.width = Math.round(image.naturalWidth * zoom);
    canvas.height = Math.round(image.naturalHeight * zoom);
    ctx.imageSmoothingEnabled = !settings.pixelArtMode;
    if (!settings.pixelArtMode) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    selections.forEach((selection) => {
      const isActive = selection.id === activeId;
      ctx.save();
      ctx.scale(zoom, zoom);
      ctx.strokeStyle = isActive ? '#ffb000' : '#10a37f';
      ctx.lineWidth = isActive ? 3 / zoom : 2 / zoom;
      ctx.setLineDash(isActive ? [] : [6 / zoom, 4 / zoom]);
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
      ctx.fillStyle = isActive ? 'rgba(255, 176, 0, 0.12)' : 'rgba(16, 163, 127, 0.10)';
      ctx.fillRect(selection.x, selection.y, selection.width, selection.height);
      ctx.setLineDash([]);
      drawHandles(ctx, selection, zoom, isActive);
      ctx.restore();
    });
  };

  const handleFile = (file: File) => {
    if (!file.type.match(/^image\/(png|jpeg|webp)$/)) {
      setStatusMessage(t.status.invalidFile);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImage(img);
      setImageName(file.name);
      setSelections([]);
      setActiveId(null);
      setCanvasOffset({ x: 0, y: 0 });
      setZoom(Math.min(1, 1200 / img.naturalWidth));
      setStatusMessage('');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const getPoint = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / zoom, 0, image?.naturalWidth ?? 0),
      y: clamp((event.clientY - rect.top) / zoom, 0, image?.naturalHeight ?? 0),
    };
  };

  const startPanDrag = (clientX: number, clientY: number) => {
    setDrag({
      type: 'pan',
      startClientX: clientX,
      startClientY: clientY,
      startOffsetX: canvasOffset.x,
      startOffsetY: canvasOffset.y,
    });
  };

  const updatePanDrag = (clientX: number, clientY: number, panDrag: Extract<DragState, { type: 'pan' }>) => {
    setCanvasOffset({
      x: panDrag.startOffsetX + clientX - panDrag.startClientX,
      y: panDrag.startOffsetY + clientY - panDrag.startClientY,
    });
  };

  const onCanvasWrapPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!image || event.target !== event.currentTarget) return;
    if (tool !== 'pan' && !spacePressedRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    startPanDrag(event.clientX, event.clientY);
  };

  const onCanvasWrapPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag?.type !== 'pan') return;
    event.preventDefault();
    updatePanDrag(event.clientX, event.clientY, drag);
  };

  const onCanvasWrapPointerUp = () => {
    if (drag?.type === 'pan') setDrag(null);
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    const point = getPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === 'pan' || spacePressedRef.current) {
      event.preventDefault();
      startPanDrag(event.clientX, event.clientY);
      return;
    }

    if (tool === 'eyedropper') {
      setSettings((current) => ({ ...current, backgroundColor: sampleImageColor(image, point.x, point.y) }));
      setTool('draw');
      return;
    }

    const hit = findHit(selections, point.x, point.y);
    if (tool === 'select' && hit) {
      setActiveId(hit.selection.id);
      if (hit.handle) {
        setDrag({ type: 'resize', id: hit.selection.id, handle: hit.handle, start: hit.selection, square: squareLocked || event.shiftKey });
      } else {
        setDrag(moveAllSelections
          ? { type: 'move-all', startX: point.x, startY: point.y, startSelections: selections }
          : { type: 'move', id: hit.selection.id, offsetX: point.x - hit.selection.x, offsetY: point.y - hit.selection.y });
      }
      return;
    }

    const id = makeUniqueId(selections);
    const next: AssetSelection = { id, name: id, x: point.x, y: point.y, width: 1, height: 1 };
    setSelections((current) => [...current, next]);
    setActiveId(id);
    setDrag({ type: 'new', startX: point.x, startY: point.y, id });
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    const point = getPoint(event);
    if (!drag) {
      updateCanvasCursor(point.x, point.y);
      return;
    }

    if (drag.type === 'pan') {
      event.preventDefault();
      updatePanDrag(event.clientX, event.clientY, drag);
      return;
    }

    setSelections((current) =>
      current.map((selection) => {
        if (drag.type !== 'move-all' && selection.id !== drag.id) return selection;
        if (drag.type === 'new') {
          const next = normalizeRect(drag.startX, drag.startY, point.x, point.y);
          const shaped = squareLocked ? forceSquare(next) : next;
          const pixelReady = settings.pixelArtMode ? roundSelection(shaped) : shaped;
          return { ...pixelReady, id: selection.id, name: selection.name };
        }
        if (drag.type === 'move') {
          const next = {
            ...selection,
            x: clamp(point.x - drag.offsetX, 0, image.naturalWidth - selection.width),
            y: clamp(point.y - drag.offsetY, 0, image.naturalHeight - selection.height),
          };
          return settings.pixelArtMode ? roundSelection(next) : next;
        }
        if (drag.type === 'move-all') {
          const dx = point.x - drag.startX;
          const dy = point.y - drag.startY;
          const original = drag.startSelections.find((item) => item.id === selection.id);
          if (!original) return selection;
          const next = {
            ...selection,
            x: clamp(original.x + dx, 0, image.naturalWidth - original.width),
            y: clamp(original.y + dy, 0, image.naturalHeight - original.height),
          };
          return settings.pixelArtMode ? roundSelection(next) : next;
        }
        const next = resizeSelection(drag, point.x, point.y, image.naturalWidth, image.naturalHeight, drag.square || squareLocked || event.shiftKey);
        return settings.pixelArtMode ? roundSelection(next) : next;
      }),
    );

  };

  const onPointerUp = () => {
    if (!drag) return;
    setSelections((current) => current.filter((selection) => selection.width >= 4 && selection.height >= 4));
    setDrag(null);
  };

  const updateCanvasCursor = (x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (tool !== 'select') {
      canvas.style.cursor = tool === 'eyedropper' ? 'copy' : tool === 'pan' ? 'grab' : 'crosshair';
      return;
    }
    const hit = findHit(selections, x, y);
    canvas.style.cursor = hit?.handle ? cursorForHandle(hit.handle) : hit ? 'move' : 'default';
  };

  const updateSelection = (id: string, patch: Partial<AssetSelection>) => {
    setSelections((current) =>
      current.map((selection) =>
        selection.id === id
          ? constrainSelection({ ...selection, ...patch }, image?.naturalWidth ?? Infinity, image?.naturalHeight ?? Infinity, squareLocked)
          : selection,
      ),
    );
  };

  const nudgeActive = (dx: number, dy: number) => {
    if (!activeSelection || !image) return;
    updateSelection(activeSelection.id, { x: activeSelection.x + dx, y: activeSelection.y + dy });
  };

  const resizeActive = (delta: number, axis?: 'width' | 'height') => {
    if (!activeSelection || !image) return;
    const patch = squareLocked || !axis
      ? { width: activeSelection.width + delta, height: activeSelection.height + delta }
      : axis === 'width'
        ? { width: activeSelection.width + delta }
        : { height: activeSelection.height + delta };
    updateSelection(activeSelection.id, patch);
  };

  const makeActiveSquare = () => {
    if (!activeSelection) return;
    const size = Math.max(activeSelection.width, activeSelection.height);
    updateSelection(activeSelection.id, { width: size, height: size });
  };

  const fitActiveToOpaquePixels = () => {
    if (!image || !activeSelection) return;
    const bounds = getTransparentCropBounds(image, activeSelection, settings);
    if (!bounds) {
      setStatusMessage(t.status.noOpaquePixels);
      return;
    }
    const padding = Math.max(0, Math.round(trimPadding));
    updateSelection(activeSelection.id, {
      x: activeSelection.x + bounds.x - padding,
      y: activeSelection.y + bounds.y - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    });
  };

  const updateExportSize = (preset: ExportSize['preset']) => {
    const size = preset === 'custom' ? settings.exportSize.width : Number(preset);
    setSettings((current) => ({ ...current, exportSize: { preset, width: size, height: size } }));
  };

  const updateExportDimension = (axis: 'width' | 'height', value: number) => {
    const safeValue = Math.max(1, Math.round(value));
    setSettings((current) => ({
      ...current,
      exportSize: {
        preset: 'custom',
        width: axis === 'width' || outputAspectLocked ? safeValue : current.exportSize.width,
        height: axis === 'height' || outputAspectLocked ? safeValue : current.exportSize.height,
      },
    }));
  };

  const updateScaleMode = (scaleMode: ScaleMode) => {
    setSettings((current) => ({ ...current, scaleMode }));
  };

  const clearSelections = () => {
    setSelections([]);
    setActiveId(null);
    setStatusMessage('');
  };

  const selectWholeImage = () => {
    if (!image) return;
    const id = makeUniqueId(selections);
    const selection = {
      id,
      name: id,
      x: 0,
      y: 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
    setSelections((current) => [...current, selection]);
    setActiveId(id);
    setTool('select');
  };

  const runAutoDetect = () => {
    if (!image) return;
    const detected = detectAssetSelections(image, settings, detectionSettings);
    if (detected.length === 0) {
      setStatusMessage(t.status.detectNone);
      return;
    }
    setSelections((current) => {
      const renamed = detected.map((selection, index) => {
        const id = makeUniqueId([...current, ...detected.slice(0, index)]);
        return { ...selection, id, name: id };
      });
      setActiveId(renamed[0]?.id ?? null);
      return [...current, ...renamed];
    });
    setTool('select');
    setStatusMessage(`${detected.length}件の${t.status.detectDone}`);
  };

  const runExport = async () => {
    if (!image || selections.length === 0) return;
    setIsExporting(true);
    try {
      await exportZip(image, selections, settings);
      setStatusMessage(t.status.exportDone);
    } catch {
      setStatusMessage(t.status.exportFailed);
    } finally {
      setIsExporting(false);
    }
  };

  const runExportSingle = async () => {
    if (!image || !activeSelection) return;
    setIsSavingSingle(true);
    try {
      await exportSinglePng(image, activeSelection, settings);
      setStatusMessage(t.status.singleExportDone);
    } catch {
      setStatusMessage(t.status.exportFailed);
    } finally {
      setIsSavingSingle(false);
    }
  };

  return (
    <main className="app-shell">
      <aside className="tool-rail" aria-label="作業ツール">
        <button className="rail-button load" onClick={() => fileInputRef.current?.click()} title={t.actions.loadImage}>読込</button>
        <button className={tool === 'draw' ? 'rail-button draw active' : 'rail-button draw'} onClick={() => setTool('draw')} title={t.tools.drawTitle}>{t.tools.draw}</button>
        <button className={tool === 'select' ? 'rail-button select active' : 'rail-button select'} onClick={() => setTool('select')} title={t.tools.selectTitle}>選択</button>
        <button className={tool === 'pan' ? 'rail-button pan active' : 'rail-button pan'} onClick={() => setTool('pan')} title="キャンバス全体をドラッグ移動します">キャンバス移動</button>
        <button className={tool === 'eyedropper' ? 'rail-button pick active' : 'rail-button pick'} onClick={() => setTool('eyedropper')} title={t.tools.eyedropperTitle}>{t.tools.eyedropper}</button>
        <button className="rail-button detect" disabled={!image} onClick={runAutoDetect} title={t.actions.detectAssets}>{t.actions.detectAssets}</button>
        <button className="rail-button" disabled={!image} onClick={selectWholeImage} title="画像全体を選択範囲にします">全体選択</button>
        <button className="rail-button danger-mini" disabled={selections.length === 0} onClick={clearSelections} title="選択範囲をすべて削除">全削除</button>
        <button className="rail-button zoom" onClick={() => setZoom((value) => Math.max(0.1, value - 0.1))} title={t.tools.zoomOut}>-</button>
        <span className="zoom-pill rail-zoom">{Math.round(zoom * 100)}%</span>
        <button className="rail-button zoom" onClick={() => setZoom((value) => Math.min(4, value + 0.1))} title={t.tools.zoomIn}>+</button>
        <p className="rail-help">Space+ドラッグでもキャンバス移動</p>
      </aside>
      <section className="editor-panel">
        <header className="topbar">
          <div>
            <h1>{t.app.name}</h1>
            <p>{imageName || t.app.emptyHint}</p>
          </div>
          <div className="top-info" aria-label="画像情報">
            <span className="info-pill">{image ? `${image.naturalWidth} x ${image.naturalHeight}px` : '画像未読込'}</span>
            <span className="info-pill">選択 {selections.length}</span>
            <span className="mode-pill">現在: {tool === 'draw' ? t.tools.draw : tool === 'select' ? '選択' : tool === 'pan' ? '移動' : t.tools.eyedropper}</span>
          </div>
        </header>

        <div
          className={tool === 'pan' || spacePressed ? 'canvas-wrap panning-ready' : 'canvas-wrap'}
          ref={canvasWrapRef}
          onPointerDown={onCanvasWrapPointerDown}
          onPointerMove={onCanvasWrapPointerMove}
          onPointerUp={onCanvasWrapPointerUp}
          onPointerCancel={onCanvasWrapPointerUp}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={tool === 'pan' || spacePressed ? 'pan' : tool}
            style={{ transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px)` }}
          />
        </div>
      </section>

      <aside className="side-panel">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <button className="primary load-action" onClick={() => fileInputRef.current?.click()}>{t.actions.loadImage}</button>
        {statusMessage && <p className="status-message">{statusMessage}</p>}

        <ControlGroup title={t.groups.transparency}>
          <label>
            {t.transparency.mode}
            <select value={settings.mode} onChange={(event) => setSettings({ ...settings, mode: event.target.value as CutterSettings['mode'] })}>
              <option value="none">{t.transparency.none}</option>
              <option value="color">{t.transparency.color}</option>
              <option value="edge">{t.transparency.edge}</option>
            </select>
          </label>
          <p className="help-text">{t.transparency.edgeHelp}</p>
          <div className="color-row">
            <span>{t.transparency.background}</span>
            <span className="swatch" style={{ backgroundColor: rgbToCss(settings.backgroundColor) }} />
            <button onClick={() => setTool('eyedropper')}>{t.actions.pick}</button>
          </div>
          <Range label={t.transparency.tolerance} help={t.transparency.toleranceHelp} min={0} max={120} value={settings.tolerance} onChange={(value) => setSettings({ ...settings, tolerance: value })} />
          <Range label={t.transparency.feather} help={t.transparency.featherHelp} min={0} max={3} value={settings.feather} onChange={(value) => setSettings({ ...settings, feather: value })} />
          <label className="check"><input type="checkbox" checked={settings.removeSpecks} onChange={(event) => setSettings({ ...settings, removeSpecks: event.target.checked })} /> {t.transparency.removeSpecks}</label>
          <p className="help-text">{t.transparency.removeSpecksHelp}</p>
          <label className="check"><input type="checkbox" checked={settings.reduceFringe} onChange={(event) => setSettings({ ...settings, reduceFringe: event.target.checked })} /> {t.transparency.reduceFringe}</label>
          <p className="help-text">{t.transparency.reduceFringeHelp}</p>
        </ControlGroup>

        <ControlGroup title={t.groups.detection}>
          <p className="help-text">{t.detection.help}</p>
          <NumberField
            label={t.detection.minArea}
            value={detectionSettings.minArea}
            min={1}
            onChange={(value) => setDetectionSettings((current) => ({ ...current, minArea: value }))}
          />
          <p className="help-text">{t.detection.minAreaHelp}</p>
          <NumberField
            label={t.detection.mergeDistance}
            value={detectionSettings.mergeDistance}
            min={0}
            onChange={(value) => setDetectionSettings((current) => ({ ...current, mergeDistance: value }))}
          />
          <p className="help-text">{t.detection.mergeDistanceHelp}</p>
          <NumberField
            label={t.detection.padding}
            value={detectionSettings.padding}
            min={0}
            onChange={(value) => setDetectionSettings((current) => ({ ...current, padding: value }))}
          />
          <p className="help-text">{t.detection.paddingHelp}</p>
          <button className="primary detect-action" disabled={!image} onClick={runAutoDetect}>{t.actions.detectAssets}</button>
        </ControlGroup>

        <ControlGroup title={t.groups.outputSize}>
          <label className="check"><input type="checkbox" checked={settings.pixelArtMode} onChange={(event) => setSettings({ ...settings, pixelArtMode: event.target.checked, resizeMethod: event.target.checked ? 'nearest' : settings.resizeMethod })} /> {t.output.pixelArtMode}</label>
          <p className="help-text">{t.output.pixelArtHelp}</p>
          <label>
            {t.output.resizeMethod}
            <select value={settings.resizeMethod} onChange={(event) => setSettings({ ...settings, resizeMethod: event.target.value as CutterSettings['resizeMethod'] })} disabled={settings.pixelArtMode}>
              <option value="nearest">{t.output.nearest}</option>
              <option value="smooth">{t.output.smooth}</option>
            </select>
          </label>
          <p className="help-text">{settings.resizeMethod === 'nearest' ? t.output.nearestHelp : t.output.smoothHelp}</p>
          <label>
            {t.output.scaleMode}
            <select value={settings.scaleMode} onChange={(event) => updateScaleMode(event.target.value as ScaleMode)}>
              <option value="fit">{t.output.fit}</option>
              <option value="original">{t.output.original}</option>
              <option value="2x">{t.output.x2}</option>
              <option value="3x">{t.output.x3}</option>
              <option value="4x">{t.output.x4}</option>
            </select>
          </label>
          <select value={settings.exportSize.preset} onChange={(event) => updateExportSize(event.target.value as ExportSize['preset'])}>
            <option value="32">32 x 32</option>
            <option value="48">48 x 48</option>
            <option value="64">64 x 64</option>
            <option value="128">128 x 128</option>
            <option value="256">256 x 256</option>
            <option value="custom">{t.output.custom}</option>
          </select>
          <div className="number-grid">
            <NumberField label="幅(px)" min={1} value={settings.exportSize.width} onChange={(value) => updateExportDimension('width', value)} />
            <NumberField label="高さ(px)" min={1} value={settings.exportSize.height} onChange={(value) => updateExportDimension('height', value)} />
          </div>
          <label className="check"><input type="checkbox" checked={outputAspectLocked} onChange={(event) => setOutputAspectLocked(event.target.checked)} /> 縦横比固定</label>
          <Range label={t.output.padding} help={t.output.paddingHelp} min={0} max={80} value={settings.padding} onChange={(value) => setSettings({ ...settings, padding: value })} />
          <label className="check"><input type="checkbox" checked={settings.autoTrim} onChange={(event) => setSettings({ ...settings, autoTrim: event.target.checked })} /> {t.output.autoTrim}</label>
        </ControlGroup>

        <ControlGroup title={t.groups.selectionDetail}>
          {activeSelection ? (
            <SelectionDetail
              selection={activeSelection}
              squareLocked={squareLocked}
              trimPadding={trimPadding}
              moveAllSelections={moveAllSelections}
              onChange={(patch) => updateSelection(activeSelection.id, patch)}
              onNudge={nudgeActive}
              onResize={resizeActive}
              onSquareLock={setSquareLocked}
              onMoveAllSelections={setMoveAllSelections}
              onMakeSquare={makeActiveSquare}
              onFitOpaque={fitActiveToOpaquePixels}
              onTrimPadding={setTrimPadding}
            />
          ) : (
            <p className="empty">{t.selection.none}</p>
          )}
        </ControlGroup>

        <ControlGroup title={`${t.groups.assetList} ${selections.length}`}>
          <div className="asset-list">
            {selections.map((selection, index) => (
              <button
                key={selection.id}
                className={selection.id === activeSelection?.id ? 'asset-row active' : 'asset-row'}
                onClick={() => {
                  setActiveId(selection.id);
                  setTool('select');
                }}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <input
                  value={selection.name}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => updateSelection(selection.id, { name: event.target.value })}
                />
                <span>{Math.round(selection.width)}x{Math.round(selection.height)}</span>
              </button>
            ))}
          </div>
          <button
            className="danger"
            disabled={!activeSelection}
            onClick={() => {
              setSelections((current) => current.filter((selection) => selection.id !== activeSelection?.id));
              setActiveId(null);
            }}
          >
            {t.actions.deleteSelection}
          </button>
        </ControlGroup>

        <ControlGroup title={t.groups.preview}>
          {image && activeSelection ? (
            <Preview image={image} selection={activeSelection} settings={settings} expanded={previewExpanded} onToggle={() => setPreviewExpanded((value) => !value)} />
          ) : (
            <p className="empty">{t.preview.empty}</p>
          )}
        </ControlGroup>

        <div className="save-actions">
          <button className="primary single-export" disabled={!image || !activeSelection || isSavingSingle} onClick={runExportSingle}>
            {isSavingSingle ? t.actions.exportSingleSaving : t.actions.exportSingle}
          </button>
          <button className="primary export" disabled={!image || selections.length === 0 || isExporting} onClick={runExport}>
            {isExporting ? t.actions.exporting : t.actions.exportZip}
          </button>
        </div>
      </aside>
    </main>
  );
};

const ControlGroup = ({ title, children }: { title: string; children: ReactNode }) => (
  <details className="control-group" open>
    <summary><h2>{title}</h2></summary>
    {children}
  </details>
);

const Range = ({
  label,
  help,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  help?: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) => (
  <label>
    <span className="range-label"><span>{label}</span><b>{value}</b></span>
    <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    {help && <span className="help-text">{help}</span>}
  </label>
);

const SelectionDetail = ({
  selection,
  squareLocked,
  trimPadding,
  moveAllSelections,
  onChange,
  onNudge,
  onResize,
  onSquareLock,
  onMoveAllSelections,
  onMakeSquare,
  onFitOpaque,
  onTrimPadding,
}: {
  selection: AssetSelection;
  squareLocked: boolean;
  trimPadding: number;
  moveAllSelections: boolean;
  onChange: (patch: Partial<AssetSelection>) => void;
  onNudge: (dx: number, dy: number) => void;
  onResize: (delta: number, axis?: 'width' | 'height') => void;
  onSquareLock: (locked: boolean) => void;
  onMoveAllSelections: (enabled: boolean) => void;
  onMakeSquare: () => void;
  onFitOpaque: () => void;
  onTrimPadding: (padding: number) => void;
}) => (
  <div className="selection-detail">
    <p className="selected-name">{t.selection.selected}: {selection.name}</p>
    <div className="number-grid">
      <NumberField label="X（横）" value={selection.x} onChange={(value) => onChange({ x: value })} />
      <NumberField label="Y（縦）" value={selection.y} onChange={(value) => onChange({ y: value })} />
      <NumberField label="W（幅）" value={selection.width} onChange={(value) => onChange(squareLocked ? { width: value, height: value } : { width: value })} />
      <NumberField label="H（高さ）" value={selection.height} onChange={(value) => onChange(squareLocked ? { width: value, height: value } : { height: value })} />
    </div>
    <div className="nudge-grid">
      <button onClick={() => onNudge(-1, 0)}>X -1</button>
      <button onClick={() => onNudge(1, 0)}>X +1</button>
      <button onClick={() => onNudge(0, -1)}>Y -1</button>
      <button onClick={() => onNudge(0, 1)}>Y +1</button>
      {squareLocked ? (
        <>
          <button onClick={() => onResize(-1)}>{t.selection.sizeMinus}</button>
          <button onClick={() => onResize(1)}>{t.selection.sizePlus}</button>
        </>
      ) : (
        <>
          <button onClick={() => onResize(-1, 'width')}>W -1</button>
          <button onClick={() => onResize(1, 'width')}>W +1</button>
          <button onClick={() => onResize(-1, 'height')}>H -1</button>
          <button onClick={() => onResize(1, 'height')}>H +1</button>
        </>
      )}
    </div>
    <label className="check"><input type="checkbox" checked={moveAllSelections} onChange={(event) => onMoveAllSelections(event.target.checked)} /> 全選択範囲をまとめて移動</label>
    <label className="check"><input type="checkbox" checked={squareLocked} onChange={(event) => onSquareLock(event.target.checked)} /> {t.selection.squareLock}</label>
    <p className="help-text">{t.selection.squareLockHelp}</p>
    <button onClick={onMakeSquare}>{t.actions.makeSquare}</button>
    <button onClick={onFitOpaque}>{t.actions.fitOpaque}</button>
    <label>
      {t.selection.trimPadding}
      <input type="number" min={0} max={256} value={trimPadding} onChange={(event) => onTrimPadding(Number(event.target.value))} />
      <span className="help-text">{t.selection.trimPaddingHelp}</span>
    </label>
  </div>
);

const NumberField = ({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}) => (
  <label>
    {label}
    <input type="number" min={min} step={1} value={Math.round(value)} onChange={(event) => onChange(Number(event.target.value))} />
  </label>
);

const Preview = ({
  image,
  selection,
  settings,
  expanded,
  onToggle,
}: {
  image: HTMLImageElement;
  selection: AssetSelection;
  settings: CutterSettings;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const beforeRef = useRef<HTMLCanvasElement | null>(null);
  const afterRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before || !after) return;
    const cropped = cropSelection(image, selection);
    const transparent = applyTransparency(cropped, settings);
    const finalCanvas = fitToOutput(transparent, settings);
    paintPreview(before, cropped, false, settings.pixelArtMode);
    paintPreview(after, finalCanvas, true, settings.pixelArtMode);
  }, [image, selection, settings]);

  return (
    <div className={expanded ? 'preview-grid expanded' : 'preview-grid'} onClick={onToggle} title="クリックでプレビューを拡大/縮小">
      <figure>
        <canvas ref={beforeRef} />
        <figcaption>{t.preview.before}</figcaption>
      </figure>
      <figure>
        <canvas ref={afterRef} />
        <figcaption>{t.preview.after}</figcaption>
      </figure>
    </div>
  );
};

const paintPreview = (target: HTMLCanvasElement, source: HTMLCanvasElement, checker = false, pixelated = false) => {
  const size = 132;
  target.width = size;
  target.height = size;
  target.classList.toggle('pixelated', pixelated);
  const ctx = target.getContext('2d');
  if (!ctx) return;
  if (checker) drawChecker(ctx, size, size);
  else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
  }
  const scale = Math.min((size - 16) / source.width, (size - 16) / source.height);
  const width = pixelated ? Math.round(source.width * scale) : source.width * scale;
  const height = pixelated ? Math.round(source.height * scale) : source.height * scale;
  const x = pixelated ? Math.round((size - width) / 2) : (size - width) / 2;
  const y = pixelated ? Math.round((size - height) / 2) : (size - height) / 2;
  ctx.imageSmoothingEnabled = !pixelated;
  if (!pixelated) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, width, height);
};

const drawChecker = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const cell = 10;
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? '#ffffff' : '#deded8';
      ctx.fillRect(x, y, cell, cell);
    }
  }
};

const drawHandles = (ctx: CanvasRenderingContext2D, selection: AssetSelection, zoom: number, isActive: boolean) => {
  const size = (isActive ? 9 : 7) / zoom;
  const points = getHandlePoints(selection);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#1f1f1f';
  points.forEach(([, x, y]) => {
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);
  });
};

const findHit = (selections: AssetSelection[], x: number, y: number) => {
  for (let i = selections.length - 1; i >= 0; i -= 1) {
    const selection = selections[i];
    const handle = hitHandle(selection, x, y);
    if (handle) return { selection, handle };
    if (x >= selection.x && y >= selection.y && x <= selection.x + selection.width && y <= selection.y + selection.height) {
      return { selection, handle: null };
    }
  }
  return null;
};

const hitHandle = (selection: AssetSelection, x: number, y: number): Handle | null => {
  const threshold = 8;
  const hit = getHandlePoints(selection).find(([, cx, cy]) => Math.abs(cx - x) <= threshold && Math.abs(cy - y) <= threshold);
  return hit?.[0] ?? null;
};

const getHandlePoints = (selection: AssetSelection): Array<[Handle, number, number]> => {
  const left = selection.x;
  const centerX = selection.x + selection.width / 2;
  const right = selection.x + selection.width;
  const top = selection.y;
  const centerY = selection.y + selection.height / 2;
  const bottom = selection.y + selection.height;
  return [
    ['nw', left, top],
    ['n', centerX, top],
    ['ne', right, top],
    ['e', right, centerY],
    ['se', right, bottom],
    ['s', centerX, bottom],
    ['sw', left, bottom],
    ['w', left, centerY],
  ];
};

const cursorForHandle = (handle: Handle) => {
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  if (handle === 'nw' || handle === 'se') return 'nwse-resize';
  return 'nesw-resize';
};

const normalizeRect = (x1: number, y1: number, x2: number, y2: number): AssetSelection => ({
  id: '',
  name: '',
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  width: Math.abs(x2 - x1),
  height: Math.abs(y2 - y1),
});

const resizeSelection = (
  drag: Extract<DragState, { type: 'resize' }>,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  squareLocked: boolean,
): AssetSelection => {
  const start = drag.start;
  const left = drag.handle.includes('w') ? x : start.x;
  const top = drag.handle.includes('n') ? y : start.y;
  const right = drag.handle.includes('e') ? x : start.x + start.width;
  const bottom = drag.handle.includes('s') ? y : start.y + start.height;
  const next = normalizeRect(
    clamp(left, 0, maxWidth),
    clamp(top, 0, maxHeight),
    clamp(right, 0, maxWidth),
    clamp(bottom, 0, maxHeight),
  );
  return { ...(squareLocked ? forceSquare(next) : next), id: start.id, name: start.name };
};

const sampleImageColor = (image: HTMLImageElement, x: number, y: number): RGB => {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { r: 255, g: 255, b: 255 };
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  return { r: data[0], g: data[1], b: data[2] };
};

const makeUniqueId = (selections: AssetSelection[]) => {
  let index = selections.length + 1;
  let id = makeId(index);
  while (selections.some((selection) => selection.id === id)) {
    index += 1;
    id = makeId(index);
  }
  return id;
};

const makeId = (index: number) => `asset_${String(index).padStart(3, '0')}`;
const rgbToCss = (color: RGB) => `rgb(${color.r}, ${color.g}, ${color.b})`;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const isEditableTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return element?.tagName === 'INPUT' || element?.tagName === 'SELECT' || element?.tagName === 'TEXTAREA';
};

const forceSquare = (selection: AssetSelection): AssetSelection => {
  const size = Math.max(selection.width, selection.height);
  return { ...selection, width: size, height: size };
};

const roundSelection = (selection: AssetSelection): AssetSelection => ({
  ...selection,
  x: Math.round(selection.x),
  y: Math.round(selection.y),
  width: Math.max(1, Math.round(selection.width)),
  height: Math.max(1, Math.round(selection.height)),
});

const constrainSelection = (
  selection: AssetSelection,
  imageWidth: number,
  imageHeight: number,
  squareLocked: boolean,
): AssetSelection => {
  const base = squareLocked ? forceSquare(selection) : selection;
  const maxWidth = Math.max(1, Math.round(imageWidth));
  const maxHeight = Math.max(1, Math.round(imageHeight));
  const size = Math.min(Math.max(1, Math.round(Math.max(base.width, base.height))), maxWidth, maxHeight);
  const width = squareLocked ? size : Math.min(Math.max(1, Math.round(base.width)), maxWidth);
  const height = squareLocked ? size : Math.min(Math.max(1, Math.round(base.height)), maxHeight);
  return {
    ...base,
    x: Math.round(clamp(base.x, 0, Math.max(0, imageWidth - width))),
    y: Math.round(clamp(base.y, 0, Math.max(0, imageHeight - height))),
    width,
    height,
  };
};
