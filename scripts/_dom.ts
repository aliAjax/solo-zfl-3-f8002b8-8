// happy-dom 环境桩：必须最先导入，应用单例会用到 window/localStorage/document
import { Window } from 'happy-dom';

export const domWindow = new Window({ url: 'http://localhost/' });
(globalThis as any).window = domWindow;
(globalThis as any).document = domWindow.document;
(globalThis as any).navigator = domWindow.navigator;
(globalThis as any).HTMLElement = domWindow.HTMLElement;
(globalThis as any).Element = domWindow.Element;
(globalThis as any).Node = domWindow.Node;
(globalThis as any).SVGElement = domWindow.SVGElement;
(globalThis as any).Event = domWindow.Event;
(globalThis as any).CustomEvent = domWindow.CustomEvent;
(globalThis as any).localStorage = domWindow.localStorage;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
