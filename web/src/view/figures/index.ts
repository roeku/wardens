// The figure layer: men, horses and banners (docs/spec/02-look.md §5–§6, 04-battle.md §9).
export { Figures, type FiguresOpts } from './figures';
export type { BannerRecord, FigureFrame, ManRecord } from './types';
export { FIG, FACE_ZOOM, DEVICE_ZOOM, registerRig, type Rig, type RigCtx, type FigState } from './rig';
export { figureShaderHooks, figureUniforms } from './material';
export { snapFigure } from './snap';
export { folkVariant } from './outfit';
