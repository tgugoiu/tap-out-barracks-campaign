// Typings for the subset of StPageFlip 2.0.7 (npm "page-flip") this reader uses.
// The package ships TypeScript sources but no declaration files.
declare module 'page-flip/dist/js/page-flip.module.js' {
  export type FlipCorner = 'top' | 'bottom';
  export type FlippingState = 'user_fold' | 'fold_corner' | 'flipping' | 'read';
  export type Orientation = 'portrait' | 'landscape';
  export type PageDensity = 'soft' | 'hard';

  export interface Point {
    x: number;
    y: number;
  }

  export interface PageRect {
    left: number;
    top: number;
    width: number;
    height: number;
    pageWidth: number;
  }

  export interface FlipSetting {
    startPage: number;
    size: 'fixed' | 'stretch';
    width: number;
    height: number;
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    drawShadow: boolean;
    flippingTime: number;
    usePortrait: boolean;
    startZIndex: number;
    autoSize: boolean;
    maxShadowOpacity: number;
    showCover: boolean;
    mobileScrollSupport: boolean;
    clickEventForward: boolean;
    useMouseEvents: boolean;
    swipeDistance: number;
    showPageCorners: boolean;
    disableFlipByClick: boolean;
  }

  export interface WidgetEvent<T> {
    data: T;
    object: PageFlip;
  }

  export interface Page {
    setDensity(density: PageDensity): void;
    getDensity(): PageDensity;
  }

  export interface FlipController {
    showCorner(globalPos: Point): void;
    getState(): FlippingState;
  }

  export interface Render {
    getRect(): PageRect;
    finishAnimation(): void;
    /** 0 = forward, 1 = back, null when idle */
    getDirection(): number | null;
  }

  export class PageFlip {
    constructor(element: HTMLElement, settings: Partial<FlipSetting>);
    loadFromHTML(items: HTMLElement[]): void;
    update(): void;
    destroy(): void;
    flip(page: number, corner?: FlipCorner): void;
    flipNext(corner?: FlipCorner): void;
    flipPrev(corner?: FlipCorner): void;
    turnToPage(page: number): void;
    getCurrentPageIndex(): number;
    getPageCount(): number;
    getOrientation(): Orientation;
    getState(): FlippingState;
    getBoundsRect(): PageRect;
    getSettings(): FlipSetting;
    getRender(): Render;
    getFlipController(): FlipController;
    getPage(index: number): Page;
    getPageCollection(): { getCurrentSpreadIndex(): number };
    startUserTouch(pos: Point): void;
    userMove(pos: Point, isTouch: boolean): void;
    userStop(pos: Point, isSwipe?: boolean): void;
    on(event: 'flip', cb: (e: WidgetEvent<number>) => void): PageFlip;
    on(event: 'changeState', cb: (e: WidgetEvent<FlippingState>) => void): PageFlip;
    on(event: 'changeOrientation', cb: (e: WidgetEvent<Orientation>) => void): PageFlip;
    on(event: 'init' | 'update', cb: (e: WidgetEvent<{ page: number; mode: Orientation }>) => void): PageFlip;
    off(event: string): void;
  }
}
