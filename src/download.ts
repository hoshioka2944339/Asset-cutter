import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import type { AssetSelection, CutterSettings } from './types';
import { canvasToBlob, createPreviewSheet, processAsset } from './imageProcessing';

export const exportSinglePng = async (
  image: HTMLImageElement,
  selection: AssetSelection,
  settings: CutterSettings,
) => {
  const asset = processAsset(image, selection, settings);
  const blob = await canvasToBlob(asset.canvas);
  saveAs(blob, asset.fileName);
};

export const exportZip = async (
  image: HTMLImageElement,
  selections: AssetSelection[],
  settings: CutterSettings,
) => {
  const zip = new JSZip();
  const assets = selections.map((selection) => processAsset(image, selection, settings));

  for (const asset of assets) {
    zip.file(asset.fileName, await canvasToBlob(asset.canvas));
  }

  const previewSheet = await createPreviewSheet(assets, settings);
  zip.file('preview_sheet.png', await canvasToBlob(previewSheet));

  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        app: 'Asset Cutter',
        exportedAt: new Date().toISOString(),
        settings,
        assets: assets.map((asset) => ({
          fileName: asset.fileName,
          originalSelectionSize: {
            width: Math.round(asset.selection.width),
            height: Math.round(asset.selection.height),
          },
          sourceRect: {
            x: Math.round(asset.selection.x),
            y: Math.round(asset.selection.y),
            width: Math.round(asset.selection.width),
            height: Math.round(asset.selection.height),
          },
          outputSize: {
            width: asset.canvas.width,
            height: asset.canvas.height,
          },
          transparencyMode: settings.mode,
          tolerance: settings.tolerance,
          padding: settings.padding,
          pixelArtMode: settings.pixelArtMode,
          resizeMethod: settings.resizeMethod,
          scaleMode: settings.scaleMode,
        })),
      },
      null,
      2,
    ),
  );

  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, 'asset-cutter-export.zip');
};
