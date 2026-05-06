// ---------------------------------------------------------------------------
// MCP Apps Extension — src/app public API
//
// Extends smallchat's Obj-C runtime/compiler analogy to full UI components:
//   AppCompiler  ≈ Interface Builder / NIB compiler
//   UIRuntime    ≈ UIKit / AppKit (UI dispatch + view lifecycle)
//   AppClass     ≈ NSViewController class (component dispatch table)
//   AppBridge    ≈ NSWindowController (iframe lifecycle management)
// ---------------------------------------------------------------------------

export { AppCompiler, deserializeAppArtifact } from './app-compiler.js';
export type { AppCompilationResult, AppCompilerOptions } from './app-compiler.js';

export { AppClass } from './app-class.js';

export { ComponentSelectorTable, canonicalizeComponent } from './component-selector.js';

export { ViewCache } from './view-cache.js';
export type { ResolvedComponent, ViewCacheVersionContext } from './view-cache.js';

export { UIRuntime } from './app-runtime.js';
export type { UIRuntimeOptions } from './app-runtime.js';

export { AppBridgeWrapper, AppBridgePool } from './app-bridge-wrapper.js';
export type { BridgeEvent, BridgeEventListener } from './app-bridge-wrapper.js';
