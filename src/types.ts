export type TransparencyMode = 'none' | 'color' | 'edge';
export type ResizeMethod = 'nearest' | 'smooth';
export type ScaleMode = 'fit' | 'original' | '2x' | '3x' | '4x';

export type RGB = {
  r: number;
  g: number;
  b: number;
};

export type AssetSelection = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExportSize = {
  preset: '32' | '48' | '64' | '128' | '256' | 'custom';
  width: number;
  height: number;
};

export type CutterSettings = {
  mode: TransparencyMode;
  backgroundColor: RGB;
  tolerance: number;
  feather: number;
  removeSpecks: boolean;
  reduceFringe: boolean;
  exportSize: ExportSize;
  scaleMode: ScaleMode;
  resizeMethod: ResizeMethod;
  pixelArtMode: boolean;
  padding: number;
  autoTrim: boolean;
};

export type DetectionSettings = {
  minArea: number;
  mergeDistance: number;
  padding: number;
};
